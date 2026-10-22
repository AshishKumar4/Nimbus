/* nimbus-signal-check.c — CPython's periodic signal check on the Nimbus host.
 *
 * patches/0004 turns on, for WASI, the hooks CPython keeps for Emscripten:
 * RESUME_CHECK and every eval-breaker check count down a clock, and at zero
 * _Py_CheckEmscriptenSignalsPeriodically asks for a signal held for the
 * process. Without them a computing interpreter makes no host call, so nothing
 * reaches it: not Ctrl-C, not a kill. Here the ask is the host's
 * nimbus_proc.signal_check, which yields its event loop a turn (so a signal
 * sent while the guest computed gets in) and answers the signal held for the
 * process, NIMBUS_ESIGNAL plus its number, or 0. A signal is raised where the
 * check stands, as Linux runs a handler between two instructions:
 * nimbus-signal.c's raise ends the process on a default action, or runs
 * CPython's handler, whose KeyboardInterrupt the next breaker check raises. */
#include <signal.h>
#include <stdlib.h>

#define NIMBUS_ESIGNAL 1024

__attribute__((import_module("nimbus_proc"), import_name("signal_check")))
int __nimbus_signal_check(void);

/* The clock RESUME_CHECK counts down too (patches/0004). */
int Py_EMSCRIPTEN_SIGNAL_HANDLING = 1;
int _Py_emscripten_signal_clock = 0;

/* Breaker checks between two asks: NIMBUS_SIGNAL_INTERVAL from the
 * environment, read at the first check; 0 never asks. */
static int interval = -1;

void _Py_CheckEmscriptenSignals(void)
{
	int answer = __nimbus_signal_check();
	if (answer > NIMBUS_ESIGNAL) {
		raise(answer - NIMBUS_ESIGNAL);
	}
}

void _Py_CheckEmscriptenSignalsPeriodically(void)
{
	if (_Py_emscripten_signal_clock > 0) {
		_Py_emscripten_signal_clock -= Py_EMSCRIPTEN_SIGNAL_HANDLING;
		return;
	}
	if (interval < 0) {
		const char *set = getenv("NIMBUS_SIGNAL_INTERVAL");
		interval = set == NULL ? 0 : atoi(set);
	}
	if (interval <= 0) {
		/* Never asks: the clock stands still above zero. */
		Py_EMSCRIPTEN_SIGNAL_HANDLING = 0;
		_Py_emscripten_signal_clock = 1;
		return;
	}
	_Py_emscripten_signal_clock = interval;
	_Py_CheckEmscriptenSignals();
}
