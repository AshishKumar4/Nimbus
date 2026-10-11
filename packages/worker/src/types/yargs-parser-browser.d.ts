// Upstream's browser entry is the same parser API, without Node platform mixins.
declare module 'yargs-parser/browser' {
  import parser = require('yargs-parser');
  export default parser;
}
