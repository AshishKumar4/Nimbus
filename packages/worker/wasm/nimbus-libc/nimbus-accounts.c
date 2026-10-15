/* The session's accounts, as musl answers them: each lookup reads
 * /etc/passwd or /etc/group again, so an account added while a program runs
 * is found, and a name or id the files do not hold is not. Bash (tilde
 * expansion) and BusyBox (ls -l, id, chown NAME) link it. */
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* `line` cut at ':' into exactly `count` fields; 0 when it has another count. */
static int split(char *line, char **fields, int count)
{
	line[strcspn(line, "\n")] = 0;
	for (int i = 0; i < count; i++) {
		fields[i] = line;
		char *colon = strchr(line, ':');
		if (i == count - 1) return colon == NULL;
		if (colon == NULL) return 0;
		*colon = 0;
		line = colon + 1;
	}
	return 1;
}

static int number(const char *text, unsigned *out)
{
	char *end;
	if (*text < '0' || *text > '9') return 0;
	errno = 0;
	unsigned long value = strtoul(text, &end, 10);
	if (*end != 0 || errno != 0 || value > UINT32_MAX) return 0;
	*out = (unsigned)value;
	return 1;
}

/* The next well-formed account of `file`, its strings in *line. */
static int next_passwd(FILE *file, char **line, size_t *size, struct passwd *pw)
{
	while (getline(line, size, file) >= 0) {
		char *field[7];
		unsigned uid, gid;
		if (!split(*line, field, 7) || !number(field[2], &uid) || !number(field[3], &gid)) continue;
		*pw = (struct passwd){ field[0], field[1], uid, gid, field[4], field[5], field[6] };
		return 1;
	}
	return 0;
}

/* The next well-formed group of `file`, its strings in *line and its member list in *members. */
static int next_group(FILE *file, char **line, size_t *size, char ***members, size_t *capacity, struct group *gr)
{
	while (getline(line, size, file) >= 0) {
		char *field[4];
		unsigned gid;
		if (!split(*line, field, 4) || !number(field[2], &gid)) continue;
		size_t count = 1;
		for (const char *p = field[3]; *p; p++) count += *p == ',';
		if (count + 1 > *capacity) {
			char **grown = realloc(*members, (count + 1) * sizeof *grown);
			if (grown == NULL) return -1;
			*members = grown;
			*capacity = count + 1;
		}
		size_t used = 0;
		for (char *p = field[3]; *p;) {
			(*members)[used++] = p;
			char *comma = strchr(p, ',');
			if (comma == NULL) break;
			*comma = 0;
			p = comma + 1;
		}
		(*members)[used] = NULL;
		*gr = (struct group){ field[0], field[1], gid, *members };
		return 1;
	}
	return 0;
}

/* 1, the account `name` names (or `uid`'s, when name is NULL) in *pw; 0, none; -1, the file could not be read (errno). */
static int find_passwd(const char *name, uid_t uid, char **line, size_t *size, struct passwd *pw)
{
	FILE *file = fopen("/etc/passwd", "r");
	if (file == NULL) return errno == ENOENT ? 0 : -1;
	int found;
	while ((found = next_passwd(file, line, size, pw)) == 1
	       && (name ? strcmp(pw->pw_name, name) != 0 : pw->pw_uid != uid)) {}
	fclose(file);
	return found;
}

static int find_group(const char *name, gid_t gid, char **line, size_t *size, char ***members, size_t *capacity, struct group *gr)
{
	FILE *file = fopen("/etc/group", "r");
	if (file == NULL) return errno == ENOENT ? 0 : -1;
	int found;
	while ((found = next_group(file, line, size, members, capacity, gr)) == 1
	       && (name ? strcmp(gr->gr_name, name) != 0 : gr->gr_gid != gid)) {}
	int saved = errno;
	fclose(file);
	errno = saved;
	return found;
}

/* The copy of `text` at *used in `buf`, or NULL when it does not fit. */
static char *place(const char *text, char *buf, size_t size, size_t *used)
{
	size_t length = strlen(text) + 1;
	if (length > size - *used) return NULL;
	char *at = memcpy(buf + *used, text, length);
	*used += length;
	return at;
}

static int copy_passwd(const struct passwd *from, struct passwd *to, char *buf, size_t size)
{
	size_t used = 0;
	*to = *from;
	if (!(to->pw_name = place(from->pw_name, buf, size, &used))
	    || !(to->pw_passwd = place(from->pw_passwd, buf, size, &used))
	    || !(to->pw_gecos = place(from->pw_gecos, buf, size, &used))
	    || !(to->pw_dir = place(from->pw_dir, buf, size, &used))
	    || !(to->pw_shell = place(from->pw_shell, buf, size, &used))) return ERANGE;
	return 0;
}

/* The member pointers first, aligned, then every string. */
static int copy_group(const struct group *from, struct group *to, char *buf, size_t size)
{
	size_t count = 0;
	while (from->gr_mem[count]) count++;
	size_t skip = (sizeof(char *) - (uintptr_t)buf % sizeof(char *)) % sizeof(char *);
	size_t table = skip + (count + 1) * sizeof(char *);
	if (table > size) return ERANGE;
	char **members = (char **)(void *)(buf + skip);
	size_t used = table;
	*to = *from;
	to->gr_mem = members;
	if (!(to->gr_name = place(from->gr_name, buf, size, &used))
	    || !(to->gr_passwd = place(from->gr_passwd, buf, size, &used))) return ERANGE;
	for (size_t i = 0; i < count; i++)
		if (!(members[i] = place(from->gr_mem[i], buf, size, &used))) return ERANGE;
	members[count] = NULL;
	return 0;
}

static int passwd_r(const char *name, uid_t uid, struct passwd *pwd, char *buf, size_t size, struct passwd **result)
{
	char *line = NULL;
	size_t capacity = 0;
	struct passwd found;
	int status = find_passwd(name, uid, &line, &capacity, &found);
	int err = status < 0 ? errno : status == 1 ? copy_passwd(&found, pwd, buf, size) : 0;
	free(line);
	*result = status == 1 && err == 0 ? pwd : NULL;
	return err;
}

static int group_r(const char *name, gid_t gid, struct group *grp, char *buf, size_t size, struct group **result)
{
	char *line = NULL;
	size_t capacity = 0;
	char **members = NULL;
	size_t slots = 0;
	struct group found;
	int status = find_group(name, gid, &line, &capacity, &members, &slots, &found);
	int err = status < 0 ? errno : status == 1 ? copy_group(&found, grp, buf, size) : 0;
	free(line);
	free(members);
	*result = status == 1 && err == 0 ? grp : NULL;
	return err;
}

int getpwnam_r(const char *name, struct passwd *pwd, char *buf, size_t size, struct passwd **result) { return passwd_r(name, 0, pwd, buf, size, result); }
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t size, struct passwd **result) { return passwd_r(NULL, uid, pwd, buf, size, result); }
int getgrnam_r(const char *name, struct group *grp, char *buf, size_t size, struct group **result) { return group_r(name, 0, grp, buf, size, result); }
int getgrgid_r(gid_t gid, struct group *grp, char *buf, size_t size, struct group **result) { return group_r(NULL, gid, grp, buf, size, result); }

/* The one record getpw* and getgr* answer with, overwritten by the next call, as POSIX allows. */
static struct passwd pw_record;
static char *pw_line;
static size_t pw_size;
static FILE *pw_file;
static struct group gr_record;
static char *gr_line;
static size_t gr_size;
static char **gr_members;
static size_t gr_slots;
static FILE *gr_file;

struct passwd *getpwnam(const char *name) { return find_passwd(name, 0, &pw_line, &pw_size, &pw_record) == 1 ? &pw_record : NULL; }
struct passwd *getpwuid(uid_t uid) { return find_passwd(NULL, uid, &pw_line, &pw_size, &pw_record) == 1 ? &pw_record : NULL; }
struct group *getgrnam(const char *name) { return find_group(name, 0, &gr_line, &gr_size, &gr_members, &gr_slots, &gr_record) == 1 ? &gr_record : NULL; }
struct group *getgrgid(gid_t gid) { return find_group(NULL, gid, &gr_line, &gr_size, &gr_members, &gr_slots, &gr_record) == 1 ? &gr_record : NULL; }

struct passwd *getpwent(void)
{
	if (pw_file == NULL && (pw_file = fopen("/etc/passwd", "r")) == NULL) return NULL;
	return next_passwd(pw_file, &pw_line, &pw_size, &pw_record) ? &pw_record : NULL;
}
void setpwent(void) { if (pw_file) rewind(pw_file); }
void endpwent(void) { if (pw_file) fclose(pw_file); pw_file = NULL; }

struct group *getgrent(void)
{
	if (gr_file == NULL && (gr_file = fopen("/etc/group", "r")) == NULL) return NULL;
	return next_group(gr_file, &gr_line, &gr_size, &gr_members, &gr_slots, &gr_record) == 1 ? &gr_record : NULL;
}
void setgrent(void) { if (gr_file) rewind(gr_file); }
void endgrent(void) { if (gr_file) fclose(gr_file); gr_file = NULL; }
