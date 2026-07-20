#include <unistd.h>
#include <stdlib.h>
int main(int argc, char **argv){
  int lines=10, ai=1;
  if(argc>=3 && argv[1][0]=='-' && argv[1][1]=='n'){ lines=atoi(argv[2]); ai=3; }
  char b[1]; int seen=0; while(read(0,b,1)>0){ write(1,b,1); if(b[0]=='\n' && ++seen>=lines) break; } return 0;
}
