// W7 reuses the W5 mock-sql harness — same SqliteVFS surface area is needed
// (writeBatch + writeStream both end up at the SQL layer). Re-export for
// clarity at the call site.
export { makeMockCtx, MockSqlStorage, MockDurableObjectStorage, MockDurableObjectState }
  from '../w5/_mock-sql.mjs';
