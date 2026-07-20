#include <unistd.h>
#include <string.h>
int main(int argc, char **argv){
  for(int i=1;i<argc;i++){ if(i>1) write(1," ",1); write(1,argv[i],strlen(argv[i])); }
  write(1,"\n",1); return 0;
}
