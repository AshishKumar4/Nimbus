/* Included by Git's compat/mmap.c under NO_MMAP_PAGED. The ordinary mmap
 * emulation still returns a contiguous allocation. This opt-in mapping
 * retains a small header and an owned descriptor; its accessors use one
 * bounded LRU shared by every mapping. WASM cannot fault in a missing page,
 * so callers must explicitly request ranges (or materialize the whole map).
 * Upstream path and the unavoidable accessor changes: PATCHES.md. */
#define MMAP_HEAD_BYTES 4096
#define MMAP_PAGE_BYTES (64 * 1024)
#define MMAP_PAGES 64

static struct paged_mmap {
	struct paged_mmap *next;
	unsigned char *head, *whole;
	size_t length;
	int fd;
} *paged_maps;

static struct mmap_page {
	const struct paged_mmap *map;
	size_t page, length;
	uint64_t used;
	unsigned char *data;
} mmap_pages[MMAP_PAGES];
static uint64_t mmap_clock;

static struct paged_mmap *find_paged_map(const void *start)
{
	struct paged_mmap *map;
	for (map = paged_maps; map; map = map->next)
		if (map->head == start)
			return map;
	return NULL;
}

void *git_mmap_paged(int fd, size_t length)
{
	struct paged_mmap *map = calloc(1, sizeof(*map));
	void *head;
	if (!map) {
		errno = ENOMEM;
		return MAP_FAILED;
	}
	head = git_mmap(NULL, length < MMAP_HEAD_BYTES ? length : MMAP_HEAD_BYTES,
			PROT_READ, MAP_PRIVATE, fd, 0);
	if (head == MAP_FAILED) {
		free(map);
		return MAP_FAILED;
	}
	map->head = head;
	map->length = length;
	map->fd = fd;
	map->next = paged_maps;
	paged_maps = map;
	return head;
}

static const struct mmap_page *read_page(const struct paged_mmap *map, size_t page)
{
	struct mmap_page *slot = NULL;
	size_t offset = st_mult(page, MMAP_PAGE_BYTES);
	ssize_t got;
	int i;
	for (i = 0; i < MMAP_PAGES; i++) {
		struct mmap_page *at = &mmap_pages[i];
		if (at->map == map && at->page == page) {
			at->used = ++mmap_clock;
			return at;
		}
		if (!slot || at->used < slot->used)
			slot = at;
	}
	if (!slot->data)
		slot->data = xmalloc(MMAP_PAGE_BYTES);
	slot->map = NULL;
	slot->length = map->length - offset < MMAP_PAGE_BYTES ?
		map->length - offset : MMAP_PAGE_BYTES;
	got = pread_in_full(map->fd, slot->data, slot->length, offset);
	if (got < 0 || (size_t)got != slot->length)
		die_errno("unable to read paged mapping");
	slot->map = map;
	slot->page = page;
	slot->used = ++mmap_clock;
	return slot;
}

const unsigned char *git_mmap_read(const void *start, size_t offset, size_t length)
{
	static unsigned char straddle[64];
	struct paged_mmap *map = find_paged_map(start);
	const struct mmap_page *slot;
	size_t page, within, first;
	if (!map)
		return (const unsigned char *)start + offset;
	if (offset > map->length || length > map->length - offset)
		die("offset beyond end of paged mapping");
	if (!length)
		return map->head;
	if (offset + length <= MMAP_HEAD_BYTES)
		return map->head + offset;
	if (map->whole)
		return map->whole + offset;
	page = offset / MMAP_PAGE_BYTES;
	within = offset % MMAP_PAGE_BYTES;
	slot = read_page(map, page);
	if (within + length <= slot->length)
		return slot->data + within;
	if (length > sizeof(straddle))
		BUG("git_mmap_read: large range across a page");
	first = slot->length - within;
	memcpy(straddle, slot->data + within, first);
	slot = read_page(map, page + 1);
	memcpy(straddle + first, slot->data, length - first);
	return straddle;
}

const unsigned char *git_mmap_whole(const void *start)
{
	struct paged_mmap *map = find_paged_map(start);
	if (!map || map->length <= MMAP_HEAD_BYTES)
		return start;
	if (!map->whole)
		map->whole = xmmap(NULL, map->length, PROT_READ, MAP_PRIVATE, map->fd, 0);
	return map->whole;
}

/* Called before ordinary git_munmap frees the header allocation. */
static void git_munmap_paged(void *start)
{
	struct paged_mmap **at;
	for (at = &paged_maps; *at; at = &(*at)->next) {
		struct paged_mmap *map = *at;
		int i;
		if (map->head != start)
			continue;
		for (i = 0; i < MMAP_PAGES; i++)
			if (mmap_pages[i].map == map) {
				mmap_pages[i].map = NULL;
				mmap_pages[i].used = 0;
			}
		*at = map->next;
		close(map->fd);
		free(map->whole);
		free(map);
		return;
	}
}
