/* Nimbus pthread parity fixture.
 *
 * Every blocking pthread primitive wasi-libc builds on its one futex wait:
 * mutex contention, condition variables (broadcast AND signal), pthread_join
 * return values, thread-local storage, barriers, semaphores, rwlocks,
 * once-init, detach, and the finite-timeout path (cond_timedwait, trylock).
 *
 * Each check is written so that a BROKEN primitive changes the printed number
 * rather than merely running slower — a primitive that does not actually
 * exclude, or does not actually block, is observable in the output.
 *
 * Writes one result line with write(2) so the binary stays small. */
#include <pthread.h>
#include <semaphore.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <time.h>

#define BUMPS 2000
#define ITEMS 100
#define NBAR 4
#define PHASES 3
#define CAP 4
#define ROUNDS 200
#define NONCE 4
#define NREADERS 3
#define RWROUNDS 50

/* ── mutex contention, join return values, TLS ──────────────────────────── */

static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
static long counter;
static __thread int tls;
static int tls_ok = 1;

static void *bumper(void *a) {
	long n = (long)a;
	tls = (int)n;
	for (long i = 0; i < n; i++) { pthread_mutex_lock(&m); counter++; pthread_mutex_unlock(&m); }
	sched_yield();
	if (tls != (int)n) tls_ok = 0;
	return (void *)n;
}

/* ── condition variable, broadcast ──────────────────────────────────────── */

static pthread_mutex_t qm = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  cv = PTHREAD_COND_INITIALIZER;
static long queue_sum;
static int  slot, slot_full;

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

/* ── barrier ────────────────────────────────────────────────────────────────
 * Each thread bumps the phase's arrival count, yields to give a broken
 * barrier every chance to let someone through early, then waits. Past the
 * barrier all NBAR arrivals must already be visible. */

static pthread_barrier_t bar;
static pthread_mutex_t bm = PTHREAD_MUTEX_INITIALIZER;
static int arrived[PHASES];
static int barrier_ok = 1;

static void *barrier_body(void *a) {
	(void)a;
	for (int ph = 0; ph < PHASES; ph++) {
		pthread_mutex_lock(&bm);
		arrived[ph]++;
		pthread_mutex_unlock(&bm);
		sched_yield();
		pthread_barrier_wait(&bar);
		if (arrived[ph] != NBAR) barrier_ok = 0;
	}
	return 0;
}

/* ── semaphores ─────────────────────────────────────────────────────────────
 * A bounded ring smaller than the item count, so the producer MUST block on a
 * full buffer and the consumer on an empty one. One producer and one consumer
 * means head/tail need no extra lock. */

static sem_t sem_empty, sem_full;
static int ring[CAP], head, tail;
static long sem_sum;

static void *sem_producer(void *a) {
	(void)a;
	for (int i = 1; i <= ITEMS; i++) {
		sem_wait(&sem_empty);
		ring[tail] = i; tail = (tail + 1) % CAP;
		sem_post(&sem_full);
	}
	return 0;
}

static void *sem_consumer(void *a) {
	(void)a;
	for (int i = 0; i < ITEMS; i++) {
		sem_wait(&sem_full);
		sem_sum += ring[head]; head = (head + 1) % CAP;
		sem_post(&sem_empty);
	}
	return 0;
}

/* ── condition variable, signal ─────────────────────────────────────────────
 * Strict ping-pong on pthread_cond_signal — the classic missed-wakeup hazard.
 * A signal delivered before its peer parks must not be lost: the peer would
 * then wait for a signal that will never come again and the program stops
 * making progress. handoffs reaches 2*ROUNDS only if every wakeup lands. */

static pthread_mutex_t sm = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  scv = PTHREAD_COND_INITIALIZER;
static int turn;
static long handoffs;

static void *pingpong(void *a) {
	long who = (long)a;
	for (int i = 0; i < ROUNDS; i++) {
		pthread_mutex_lock(&sm);
		while (turn != who) pthread_cond_wait(&scv, &sm);
		handoffs++;
		turn = 1 - (int)who;
		pthread_cond_signal(&scv);
		pthread_mutex_unlock(&sm);
	}
	return 0;
}

/* ── once-init ──────────────────────────────────────────────────────────── */

static pthread_once_t once_ctl = PTHREAD_ONCE_INIT;
static int once_count;

static void once_init(void) { once_count++; }

static void *once_body(void *a) {
	(void)a;
	sched_yield();
	pthread_once(&once_ctl, once_init);
	return 0;
}

/* ── rwlock ─────────────────────────────────────────────────────────────────
 * The writer yields between the two halves of its update while holding the
 * write lock, so a reader that is not actually excluded is guaranteed to
 * observe the torn pair rather than merely being likely to. */

static pthread_rwlock_t rw = PTHREAD_RWLOCK_INITIALIZER;
static int rw_a, rw_b;
static int rw_ok = 1;

static void *rw_writer(void *a) {
	(void)a;
	for (int i = 1; i <= RWROUNDS; i++) {
		pthread_rwlock_wrlock(&rw);
		rw_a = i;
		sched_yield();
		rw_b = i;
		pthread_rwlock_unlock(&rw);
		sched_yield();
	}
	return 0;
}

static void *rw_reader(void *a) {
	(void)a;
	for (int i = 0; i < RWROUNDS; i++) {
		pthread_rwlock_rdlock(&rw);
		if (rw_a != rw_b) rw_ok = 0;
		pthread_rwlock_unlock(&rw);
		sched_yield();
	}
	return 0;
}

/* ── detach ─────────────────────────────────────────────────────────────── */

static sem_t det_done;
static int det_ran;

static void *det_body(void *a) {
	(void)a;
	det_ran = 1;
	sem_post(&det_done);
	return 0;
}

/* ── output ─────────────────────────────────────────────────────────────── */

static char *lit(char *p, const char *s) {
	while (*s) *p++ = *s++;
	return p;
}

static char *num(char *p, long v) {
	char t[24]; int n = 0;
	if (!v) t[n++] = '0';
	while (v) { t[n++] = '0' + (char)(v % 10); v /= 10; }
	while (n) *p++ = t[--n];
	return p;
}

static char *field(char *p, const char *name, long v) {
	p = lit(p, name);
	*p++ = '=';
	return num(p, v);
}

int main(void) {
	pthread_t th[NBAR > NONCE ? NBAR : NONCE];
	pthread_t a, b, c, d, det;
	void *ra, *rb;
	int i;

	/* mutex contention + join + TLS */
	pthread_create(&a, 0, bumper, (void *)(long)BUMPS);
	pthread_create(&b, 0, bumper, (void *)(long)BUMPS);
	pthread_join(a, &ra);
	pthread_join(b, &rb);

	/* condvar broadcast */
	pthread_create(&c, 0, producer, 0);
	pthread_create(&d, 0, consumer, 0);
	pthread_join(c, 0);
	pthread_join(d, 0);

	/* barrier */
	pthread_barrier_init(&bar, 0, NBAR);
	for (i = 0; i < NBAR; i++) pthread_create(&th[i], 0, barrier_body, 0);
	for (i = 0; i < NBAR; i++) pthread_join(th[i], 0);
	pthread_barrier_destroy(&bar);

	/* semaphores */
	sem_init(&sem_empty, 0, CAP);
	sem_init(&sem_full, 0, 0);
	pthread_create(&c, 0, sem_producer, 0);
	pthread_create(&d, 0, sem_consumer, 0);
	pthread_join(c, 0);
	pthread_join(d, 0);

	/* condvar signal ping-pong */
	pthread_create(&c, 0, pingpong, (void *)0L);
	pthread_create(&d, 0, pingpong, (void *)1L);
	pthread_join(c, 0);
	pthread_join(d, 0);

	/* once-init */
	for (i = 0; i < NONCE; i++) pthread_create(&th[i], 0, once_body, 0);
	for (i = 0; i < NONCE; i++) pthread_join(th[i], 0);

	/* rwlock */
	pthread_create(&c, 0, rw_writer, 0);
	for (i = 0; i < NREADERS; i++) pthread_create(&th[i], 0, rw_reader, 0);
	pthread_join(c, 0);
	for (i = 0; i < NREADERS; i++) pthread_join(th[i], 0);

	/* detach */
	sem_init(&det_done, 0, 0);
	pthread_create(&det, 0, det_body, 0);
	pthread_detach(det);
	sem_wait(&det_done);

	/* finite-timeout path: nobody ever signals tcv, so the wait must expire
	 * with ETIMEDOUT rather than hang or wake early. */
	int timedwait_ok = 0;
	{
		static pthread_mutex_t tm = PTHREAD_MUTEX_INITIALIZER;
		static pthread_cond_t  tcv = PTHREAD_COND_INITIALIZER;
		struct timespec ts;
		clock_gettime(CLOCK_REALTIME, &ts);
		ts.tv_nsec += 100000000L;
		if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
		pthread_mutex_lock(&tm);
		int rc = pthread_cond_timedwait(&tcv, &tm, &ts);
		pthread_mutex_unlock(&tm);
		timedwait_ok = (rc == ETIMEDOUT);
	}

	/* trylock must fail on a held mutex and succeed on a free one */
	int trylock_ok;
	{
		static pthread_mutex_t tl = PTHREAD_MUTEX_INITIALIZER;
		pthread_mutex_lock(&tl);
		int busy = pthread_mutex_trylock(&tl);
		pthread_mutex_unlock(&tl);
		int freed = pthread_mutex_trylock(&tl);
		pthread_mutex_unlock(&tl);
		trylock_ok = (busy == EBUSY && freed == 0);
	}

	char out[320], *p = out;
	p = lit(p, "PTHREAD ");
	p = field(p, "counter", counter);
	p = field(lit(p, " "), "joined", (long)ra + (long)rb);
	p = field(lit(p, " "), "condvar", queue_sum);
	p = field(lit(p, " "), "tls", tls_ok);
	p = field(lit(p, " "), "mainTls", tls);
	p = field(lit(p, " "), "barrier", barrier_ok);
	p = field(lit(p, " "), "sem", sem_sum);
	p = field(lit(p, " "), "signal", handoffs);
	p = field(lit(p, " "), "once", once_count);
	p = field(lit(p, " "), "rwlock", rw_ok);
	p = field(lit(p, " "), "detach", det_ran);
	p = field(lit(p, " "), "timedwait", timedwait_ok);
	p = field(lit(p, " "), "trylock", trylock_ok);
	*p++ = '\n';
	write(1, out, (size_t)(p - out));
	return 0;
}
