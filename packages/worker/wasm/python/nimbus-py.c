/* nimbus-py.c — the entry points the Nimbus runner calls.
 *
 * The interpreter is built as a WASI *reactor*, not a command. A command module
 * has one entry, _start, and WASI says it runs once; that is enough for
 * `python script.py` and nothing else. A REPL has to keep an interpreter alive
 * across turns, and a server has to still be running when the next request
 * arrives — and in workerd a request context cannot resume a wasm stack that a
 * different request suspended, so "still running" cannot mean a parked stack.
 * It has to mean state on the guest heap that a fresh entry can pick up. Python
 * generators are exactly that, the way Ruby fibers are for ruby-runner, and a
 * reactor is what lets the host enter the VM again to resume one.
 *
 * The surface is deliberately three calls rather than raw CPython C-API over
 * the wasm boundary: the host writes UTF-8 into guest memory and asks for it to
 * be run, and everything about interpreter configuration, exception handling
 * and exit-code extraction stays on this side. */

#include <Python.h>
#include <string.h>

#include "nimbus-ext.h"

void nimbus_py_flush(void);

/* Reads back the exit status of a SystemExit that reached top level, with the
 * same rules as CPython's own main: no code or None is success, an int is the
 * status, anything else prints and is a failure. */
static int exit_status_from(PyObject *exc)
{
	PyObject *code = PyObject_GetAttrString(exc, "code");
	if (code == NULL) {
		PyErr_Clear();
		return 1;
	}
	int status;
	if (code == Py_None) {
		status = 0;
	} else if (PyLong_Check(code)) {
		status = (int)PyLong_AsLong(code);
	} else {
		PyObject_Print(code, stderr, Py_PRINT_RAW);
		fputc('\n', stderr);
		status = 1;
	}
	Py_DECREF(code);
	return status;
}

/* Brings the interpreter up against a stdlib rooted at `home`. Returns 0, or -1
 * with the reason already on stderr.
 *
 * Isolated config, because every input CPython would otherwise take from the
 * environment is one the host means to control: argv is set by running Python
 * rather than parsed here, site-packages comes from the session's filesystem,
 * and signal handlers have nothing to deliver. Bytecode writing is off because
 * __pycache__ directories would be written back into the session's VFS on every
 * import, which is a lot of persisted bytes for no reuse — the interpreter is
 * gone at the end of the turn either way. */
__attribute__((export_name("nimbus_py_init")))
int nimbus_py_init(const char *home)
{
	if (nimbus_ext_register() < 0) {
		return -1;
	}

	PyConfig config;
	PyConfig_InitIsolatedConfig(&config);
	config.parse_argv = 0;
	config.install_signal_handlers = 0;
	config.write_bytecode = 0;
	config.user_site_directory = 0;
	config.buffered_stdio = 0;

	PyStatus status = PyConfig_SetBytesString(&config, &config.home, home);

	/* The search path is stated rather than discovered. getpath.c would find it
	 * by probing for landmark files, which works but makes the layout an
	 * implicit contract between the interpreter and whoever assembled the
	 * filesystem — and when the probe fails, the only symptom is "Failed to
	 * import encodings module" with nothing about where it looked. The host
	 * already knows where it put the stdlib. */
	if (!PyStatus_Exception(status)) {
		char buf[512];
		const char *suffixes[] = {
			"/lib/python" Py_STRINGIFY(PY_MAJOR_VERSION) Py_STRINGIFY(PY_MINOR_VERSION) ".zip",
			"/lib/python" Py_STRINGIFY(PY_MAJOR_VERSION) "." Py_STRINGIFY(PY_MINOR_VERSION),
			"/lib/python" Py_STRINGIFY(PY_MAJOR_VERSION) "." Py_STRINGIFY(PY_MINOR_VERSION)
				"/lib-dynload",
		};
		config.module_search_paths_set = 1;
		for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++) {
			snprintf(buf, sizeof(buf), "%s%s", home, suffixes[i]);
			status = PyWideStringList_Append(&config.module_search_paths,
			                                 Py_DecodeLocale(buf, NULL));
			if (PyStatus_Exception(status)) {
				break;
			}
		}
	}

	if (!PyStatus_Exception(status)) {
		status = Py_InitializeFromConfig(&config);
	}
	PyConfig_Clear(&config);
	if (PyStatus_Exception(status)) {
		fprintf(stderr, "nimbus: python init failed: %s\n",
		        status.err_msg ? status.err_msg : "unknown");
		return -1;
	}
	return 0;
}

/* Runs `src` in __main__, which is the same namespace every previous call used,
 * so definitions and generators persist between entries. Returns the exit
 * status: 0 for success, the SystemExit code where there was one, 1 for any
 * other exception (already printed). */
__attribute__((export_name("nimbus_py_run")))
int nimbus_py_run(const char *src)
{
	PyObject *main_module = PyImport_AddModule("__main__");
	if (main_module == NULL) {
		PyErr_Print();
		return 1;
	}
	PyObject *globals = PyModule_GetDict(main_module);
	PyObject *result = PyRun_StringFlags(src, Py_file_input, globals, globals, NULL);
	if (result != NULL) {
		Py_DECREF(result);
		nimbus_py_flush();
		return 0;
	}

	int status;
	if (PyErr_ExceptionMatches(PyExc_SystemExit)) {
		PyObject *exc = PyErr_GetRaisedException();
		status = exit_status_from(exc);
		Py_XDECREF(exc);
	} else {
		PyErr_Print();
		status = 1;
	}
	nimbus_py_flush();
	return status;
}

/* The host reads stdout and stderr between entries, so anything Python has
 * buffered has to reach fd 1 and 2 before this call returns. Nothing finalises
 * the interpreter at the end of a turn — that is the point of a reactor — so
 * the flush at exit never comes. */
__attribute__((export_name("nimbus_py_flush")))
void nimbus_py_flush(void)
{
	PyObject *stdout_file = PySys_GetObject("stdout");
	if (stdout_file != NULL) {
		PyObject *r = PyObject_CallMethod(stdout_file, "flush", NULL);
		Py_XDECREF(r);
	}
	PyObject *stderr_file = PySys_GetObject("stderr");
	if (stderr_file != NULL) {
		PyObject *r = PyObject_CallMethod(stderr_file, "flush", NULL);
		Py_XDECREF(r);
	}
	PyErr_Clear();
	fflush(stdout);
	fflush(stderr);
}
