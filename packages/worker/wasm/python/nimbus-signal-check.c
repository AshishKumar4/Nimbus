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

#define NIMBUS_ESIGNAL 1024

__attribute__((import_module("nimbus_proc"), import_name("signal_check")))
int __nimbus_signal_check(void);

/* The clock RESUME_CHECK counts down too (patches/0004). */
int Py_EMSCRIPTEN_SIGNAL_HANDLING = 1;
int _Py_emscripten_signal_clock = 0;

/* Breaker checks between two asks. Measured on throwaways (2026-10-22,
 * verdict 20261022T235009-25265f1e507e): an ask costs 2.2-4.1 us (asking at
 * every check against never), and a loop's breaker check comes every 0.37 us,
 * so asking every 1e4 costs about 0.1%, every 1e3 about 1%. A one-shot's wall
 * showed neither: at 1e3 to 1e6, each paired difference's 95% interval holds
 * 0. Ctrl-C to the prompt
 * took 370-781 ms at 1e4, 416-1507 ms at 1e3 and up to 1812 ms at 1e6: the
 * signal's way to the guest, not the interval, sets it. */
#define NIMBUS_SIGNAL_INTERVAL 10000

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
	_Py_emscripten_signal_clock = NIMBUS_SIGNAL_INTERVAL;
	_Py_CheckEmscriptenSignals();
}
