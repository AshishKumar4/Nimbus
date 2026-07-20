#include <setjmp.h>
__attribute__((import_module("nimbus_proc"),import_name("fork"))) extern int np_fork(void);
__attribute__((import_module("env"),import_name("emit"))) extern void emit(int,int);
static jmp_buf jb;
__attribute__((export_name("run"))) int run(void){
  volatile int x=7;
  if(setjmp(jb)){ emit(2,x); return x; }
  int pid=np_fork();
  emit(1,pid);
  if(pid==0){ x=99; longjmp(jb,1); }
  return pid;
}
