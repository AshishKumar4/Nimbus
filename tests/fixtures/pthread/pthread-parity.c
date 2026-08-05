/* Nimbus pthread parity fixture — mutex contention, condvar signal/wait,
 * pthread_join return values, and thread-local storage.
 * Writes one result line with write(2) so the binary stays small. */
#include <pthread.h>
#include <unistd.h>
#include <string.h>

static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t qm = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  cv = PTHREAD_COND_INITIALIZER;
static long counter, queue_sum;
static int  slot, slot_full;
static __thread int tls;
static int tls_ok = 1;

#define BUMPS 2000
#define ITEMS 100

static void *bumper(void *a) {
	long n = (long)a;
	tls = (int)n;
	for (long i = 0; i < n; i++) { pthread_mutex_lock(&m); counter++; pthread_mutex_unlock(&m); }
	sched_yield();
	if (tls != (int)n) tls_ok = 0;
	return (void *)n;
}

static void *producer(void *a) {
	(void)a;
	for (int i = 1; i <= ITEMS; i++) {
		pthread_mutex_lock(&qm);
		while (slot_full) pthread_cond_wait(&cv, &qm);
		slot = i; slot_full = 1;
		pthread_cond_broadcast(&cv);
		pthread_mutex_unlock(&qm);
	}
	return 0;
}

static void *consumer(void *a) {
	(void)a;
	for (int i = 0; i < ITEMS; i++) {
		pthread_mutex_lock(&qm);
		while (!slot_full) pthread_cond_wait(&cv, &qm);
		queue_sum += slot; slot_full = 0;
		pthread_cond_broadcast(&cv);
		pthread_mutex_unlock(&qm);
	}
	return 0;
}

static char *num(char *p, long v) {
	char t[24]; int n = 0;
	if (!v) t[n++] = '0';
	while (v) { t[n++] = '0' + (char)(v % 10); v /= 10; }
	while (n) *p++ = t[--n];
	return p;
}

int main(void) {
	pthread_t a, b, c, d;
	void *ra, *rb;
	pthread_create(&a, 0, bumper, (void *)(long)BUMPS);
	pthread_create(&b, 0, bumper, (void *)(long)BUMPS);
	pthread_join(a, &ra);
	pthread_join(b, &rb);
	pthread_create(&c, 0, producer, 0);
	pthread_create(&d, 0, consumer, 0);
	pthread_join(c, 0);
	pthread_join(d, 0);

	char out[160], *p = out;
	memcpy(p, "PTHREAD counter=", 16); p += 16; p = num(p, counter);
	memcpy(p, " joined=", 8); p += 8; p = num(p, (long)ra + (long)rb);
	memcpy(p, " condvar=", 9); p += 9; p = num(p, queue_sum);
	memcpy(p, " tls=", 5); p += 5; p = num(p, tls_ok);
	memcpy(p, " mainTls=", 9); p += 9; p = num(p, tls);
	*p++ = '\n';
	write(1, out, (size_t)(p - out));
	return 0;
}
