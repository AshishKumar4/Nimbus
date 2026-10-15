#ifndef NIMBUS_RESTART_H
#define NIMBUS_RESTART_H

/* What a Nimbus host answers a read or write it gave up waiting on: a wasm
 * stack it holds suspended past its bound never resumes, so a wait that
 * would outlast the bound returns this instead, and the wrappers in
 * nimbus-restart.c ask again, as Linux restarts a call its ERESTARTSYS
 * interrupted. A program never sees it. Outside WASI's errno numbers (0-76);
 * a host answers it only to an image linked with the wrappers (its runner
 * key says so), and a signal still interrupts a wait with EINTR. */
#define NIMBUS_ERESTART 512

#endif
