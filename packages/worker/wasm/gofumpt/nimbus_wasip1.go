// Linked only into the pinned Go toolchain's syscall package by build-compat.mjs.
package syscall

import "unsafe"

//go:wasmimport nimbus_proc startup_dir
//go:noescape
func nimbusStartupDir(out *byte, capacity uint32, length *uint32) Errno

//go:wasmimport nimbus_proc signal_check
func nimbusSignalCheck() Errno

//go:wasmimport nimbus_fs path_access
//go:noescape
func nimbusPathAccess(fd int32, flags lookupflags, path *byte, length size, mode uint32) Errno

//go:wasmimport nimbus_fs path_stat
//go:noescape
func nimbusPathStat(fd int32, flags lookupflags, path *byte, length size, out unsafe.Pointer) Errno

//go:wasmimport nimbus_fs fd_stat
//go:noescape
func nimbusFdStat(fd int32, out unsafe.Pointer) Errno

//go:wasmimport nimbus_fs umask
//go:noescape
func nimbusUmask(mask uint32, previous *uint32) Errno

//go:wasmimport nimbus_fs fd_chmod
func nimbusFdChmod(fd int32, mode uint32) Errno

// The 80-byte nimbus_fs stat record is not Go's Stat_t: Mode is a u32
// on the wire and an int in Go, with different offsets for Uid and Gid.
type nimbusFileStat struct {
	preview1       [8]uint64
	mode, uid, gid uint32
	pad            uint32
}

func (raw *nimbusFileStat) copyTo(out *Stat_t) {
	*(*[8]uint64)(unsafe.Pointer(out)) = raw.preview1
	out.Mode, out.Uid, out.Gid = int(raw.mode), raw.uid, raw.gid
}

func nimbusInitCwd() {
	var length uint32
	if nimbusStartupDir(nil, 0, &length) == 0 {
		buf := make([]byte, length+1)
		if nimbusStartupDir(&buf[0], uint32(len(buf)), &length) == 0 {
			dir := string(buf[:length])
			fd, path, size := preparePath(dir)
			if nimbusPathAccess(fd, LOOKUP_SYMLINK_FOLLOW, path, size, 1) == 0 && Chdir(dir) == nil {
				return
			}
		}
	}
	msg := []byte("cannot enter startup directory\n")
	var written size
	fd_write(2, makeIOVec(msg), 1, &written)
	Exit(127)
}

const (
	nimbusRestart Errno = 512
	nimbusSignal  Errno = 1024
)

// The supervisor delivers the terminating signals in NIMBUS_SIGNAL_ERRNOS.
// gofumpt has no signal handlers: take their default action in the guest.
func nimbusTakeSignal(e Errno) Errno {
	if e > nimbusSignal && e <= nimbusSignal+64 {
		Exit(128 + int(e-nimbusSignal))
	}
	return e
}

func nimbusWait(call func() Errno) Errno {
	for {
		e := call()
		if e != nimbusRestart {
			return nimbusTakeSignal(e)
		}
	}
}

var nimbusSteps uint32

// NimbusCheckpoint is called at frequent points in scanner, AST and printer
// work. The yielding import runs on the normal guest stack, not the Go
// scheduler stack. It is cooperative, not general Go/Wasm preemption.
func NimbusCheckpoint() {
	nimbusSteps++
	if nimbusSteps&8191 == 1 {
		nimbusTakeSignal(nimbusSignalCheck())
	}
}
