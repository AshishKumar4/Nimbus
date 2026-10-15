/* The session's accounts: getpw* and getgr*, and their _r forms, each one
 * nimbus_proc.account call, which the host answers from /etc/passwd or
 * /etc/group as they are now (core shell/unix-accounts.ts, the shell's one
 * parser of them), so an account added while a program runs is found, and a
 * name or id the files do not hold is not. This only marshals the record the
 * host lays out: two u32s, then NUL-ended strings. Bash (tilde expansion)
 * and BusyBox (ls -l, stat, chown NAME) link it. */
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

__attribute__((import_module("nimbus_proc"), import_name("account")))
extern int __nimbus_account(unsigned kind, unsigned by, const char *name, unsigned length, unsigned id,
                            void *out, unsigned capacity, unsigned *needed);

enum { USER = 0, GROUP = 1 };
enum { BY_ID = 0, BY_NAME = 1, BY_INDEX = 2 };

/* 1, the record in buf[0..*needed); 0, no such account; -1, errno set: ERANGE when it needs *needed bytes. */
static int ask(unsigned kind, unsigned by, const char *name, unsigned id, char *buf, size_t size, unsigned *needed)
{
	int err = __nimbus_account(kind, by, name, name ? strlen(name) : 0, id, buf, size > UINT32_MAX ? UINT32_MAX : (unsigned)size, needed);
	if (err == 0) return 1;
	if (err == ENOENT) return 0;
	errno = err;
	return -1;
}

/* Like ask, into *buf, grown until the record fits: one call for any account that fits a line's worth. */
static int ask_grown(unsigned kind, unsigned by, const char *name, unsigned id, char **buf, size_t *size)
{
	if (*buf == NULL) {
		if ((*buf = malloc(1024)) == NULL) return -1;
		*size = 1024;
	}
	for (;;) {
		unsigned needed = 0;
		int found = ask(kind, by, name, id, *buf, *size, &needed);
		if (found >= 0 || errno != ERANGE) return found;
		char *grown = realloc(*buf, needed);
		if (grown == NULL) return -1;
		*buf = grown;
		*size = needed;
	}
}

static unsigned u32(const char *at) { uint32_t value; memcpy(&value, at, sizeof value); return value; }
static char *next(char *string) { return string + strlen(string) + 1; }

static void as_passwd(char *record, struct passwd *pw)
{
	pw->pw_uid = u32(record);
	pw->pw_gid = u32(record + 4);
	pw->pw_name = record + 8;
	pw->pw_passwd = next(pw->pw_name);
	pw->pw_gecos = next(pw->pw_passwd);
	pw->pw_dir = next(pw->pw_gecos);
	pw->pw_shell = next(pw->pw_dir);
}

/* The member list at `members`, (count + 1) slots. */
static void as_group(char *record, char **members, struct group *gr)
{
	unsigned count = u32(record + 4);
	gr->gr_gid = u32(record);
	gr->gr_name = record + 8;
	gr->gr_passwd = next(gr->gr_name);
	char *member = next(gr->gr_passwd);
	for (unsigned i = 0; i < count; i++, member = next(member)) members[i] = member;
	members[count] = NULL;
	gr->gr_mem = members;
}

static int passwd_r(unsigned by, const char *name, unsigned id, struct passwd *pwd, char *buf, size_t size, struct passwd **result)
{
	unsigned needed = 0;
	int found = ask(USER, by, name, id, buf, size, &needed);
	*result = NULL;
	if (found < 0) return errno;
	if (found == 0) return 0;
	as_passwd(buf, pwd);
	*result = pwd;
	return 0;
}

/* The record first, then its member list, aligned, in the caller's buffer. */
static int group_r(unsigned by, const char *name, unsigned id, struct group *grp, char *buf, size_t size, struct group **result)
{
	unsigned needed = 0;
	int found = ask(GROUP, by, name, id, buf, size, &needed);
	*result = NULL;
	if (found < 0) return errno;
	if (found == 0) return 0;
	size_t table = (needed + sizeof(char *) - 1) / sizeof(char *) * sizeof(char *);
	size_t slots = (size_t)u32(buf + 4) + 1;
	if (table + slots * sizeof(char *) > size) return ERANGE;
	as_group(buf, (char **)(void *)(buf + table), grp);
	*result = grp;
	return 0;
}

int getpwnam_r(const char *name, struct passwd *pwd, char *buf, size_t size, struct passwd **result) { return passwd_r(BY_NAME, name, 0, pwd, buf, size, result); }
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t size, struct passwd **result) { return passwd_r(BY_ID, NULL, uid, pwd, buf, size, result); }
int getgrnam_r(const char *name, struct group *grp, char *buf, size_t size, struct group **result) { return group_r(BY_NAME, name, 0, grp, buf, size, result); }
int getgrgid_r(gid_t gid, struct group *grp, char *buf, size_t size, struct group **result) { return group_r(BY_ID, NULL, gid, grp, buf, size, result); }

/* The one record getpw* and getgr* answer with, overwritten by the next call, as POSIX allows. */
static struct passwd pw_record;
static char *pw_buf;
static size_t pw_size;
static unsigned pw_next;
static struct group gr_record;
static char *gr_buf;
static size_t gr_size;
static char **gr_members;
static size_t gr_slots;
static unsigned gr_next;

static struct passwd *passwd(unsigned by, const char *name, unsigned id)
{
	if (ask_grown(USER, by, name, id, &pw_buf, &pw_size) != 1) return NULL;
	as_passwd(pw_buf, &pw_record);
	return &pw_record;
}

static struct group *group(unsigned by, const char *name, unsigned id)
{
	if (ask_grown(GROUP, by, name, id, &gr_buf, &gr_size) != 1) return NULL;
	size_t slots = (size_t)u32(gr_buf + 4) + 1;
	if (slots > gr_slots) {
		char **grown = realloc(gr_members, slots * sizeof *grown);
		if (grown == NULL) return NULL;
		gr_members = grown;
		gr_slots = slots;
	}
	as_group(gr_buf, gr_members, &gr_record);
	return &gr_record;
}

struct passwd *getpwnam(const char *name) { return passwd(BY_NAME, name, 0); }
struct passwd *getpwuid(uid_t uid) { return passwd(BY_ID, NULL, uid); }
struct passwd *getpwent(void) { struct passwd *pw = passwd(BY_INDEX, NULL, pw_next); if (pw) pw_next++; return pw; }
void setpwent(void) { pw_next = 0; }
void endpwent(void) { pw_next = 0; }

struct group *getgrnam(const char *name) { return group(BY_NAME, name, 0); }
struct group *getgrgid(gid_t gid) { return group(BY_ID, NULL, gid); }
struct group *getgrent(void) { struct group *gr = group(BY_INDEX, NULL, gr_next); if (gr) gr_next++; return gr; }
void setgrent(void) { gr_next = 0; }
void endgrent(void) { gr_next = 0; }
