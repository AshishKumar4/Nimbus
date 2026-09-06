import { Database } from 'bun:sqlite';

export function createSqliteVfsTestHarness(db = new Database(':memory:')) {
  let fault = null;
  let afterTransactionFault = null;
  let statementCount = 0;
  let transactionCount = 0;
  let activeTransaction = null;
  let transactionStatement = 0;
  const statements = [];

  const sql = {
    exec(query, ...params) {
      statementCount++;
      if (activeTransaction !== null) transactionStatement++;
      const statement = {
        sql: query,
        params,
        transaction: activeTransaction,
        transactionStatement: activeTransaction === null ? null : transactionStatement,
      };
      statements.push(statement);
      if (fault?.kind === 'injector') {
        const error = fault.inject(statement);
        if (error !== null && error !== undefined) throw error;
      }
      if (fault !== null) {
        const shouldThrow = fault.kind === 'injector'
          ? false
          : fault.kind === 'global'
          ? --fault.remaining === 0
          : statement.transactionStatement === fault.statement
            && (fault.transaction === null || statement.transaction === fault.transaction);
        if (shouldThrow) {
          const error = fault.error;
          if (!fault.repeat) fault = null;
          throw error;
        }
      }
      const prepared = db.query(query);
      if (prepared.columnNames.length === 0) {
        // A prepared statement consumes ONE statement and silently discards the
        // rest of the string, where workerd's exec runs every statement in it.
        // `run` runs them all, and a statement with no result columns has no
        // rows to hand back.
        db.run(query, ...params);
        return [];
      }
      return prepared.all(...params);
    },
  };

  const storage = {
    transactionSync(callback) {
      // bun:sqlite uses savepoints for nested calls, matching the host port.
      const parentTransaction = activeTransaction;
      const parentStatement = transactionStatement;
      activeTransaction = ++transactionCount;
      transactionStatement = 0;
      try {
        const result = db.transaction(callback)();
        if (
          afterTransactionFault !== null
          && (afterTransactionFault.transaction === null
            || afterTransactionFault.transaction === activeTransaction)
        ) {
          const error = afterTransactionFault.error;
          if (!afterTransactionFault.repeat) afterTransactionFault = null;
          throw error;
        }
        return result;
      } finally {
        activeTransaction = parentTransaction;
        transactionStatement = parentStatement;
      }
    },
  };

  return {
    db,
    sql,
    ctx: { storage },
    failOnStatement(offset, error = new Error(`injected SQL fault at statement ${offset}`)) {
      if (!Number.isInteger(offset) || offset < 1) {
        throw new RangeError('statement fault offset must be a positive integer');
      }
      fault = { kind: 'global', remaining: offset, error, repeat: false };
    },
    failOnTransactionStatement(
      statement,
      {
        transaction = transactionCount + 1,
        repeat = false,
        error = new Error(`injected SQL fault at transaction statement ${statement}`),
      } = {},
    ) {
      if (!Number.isInteger(statement) || statement < 1) {
        throw new RangeError('transaction statement must be a positive integer');
      }
      if (transaction !== null && (!Number.isInteger(transaction) || transaction < 1)) {
        throw new RangeError('transaction must be null or a positive integer');
      }
      fault = { kind: 'transaction', statement, transaction, repeat, error };
    },
    failAfterTransaction(
      {
        transaction = transactionCount + 1,
        repeat = false,
        error = new Error(`injected reset after transaction ${transaction}`),
      } = {},
    ) {
      if (transaction !== null && (!Number.isInteger(transaction) || transaction < 1)) {
        throw new RangeError('transaction must be null or a positive integer');
      }
      afterTransactionFault = { transaction, repeat, error };
    },
    setFaultInjector(inject) {
      if (typeof inject !== 'function') throw new TypeError('fault injector must be a function');
      fault = { kind: 'injector', inject };
    },
    clearFault() {
      fault = null;
      afterTransactionFault = null;
    },
    get statementCount() {
      return statementCount;
    },
    get transactionCount() {
      return transactionCount;
    },
    get statements() {
      return statements.map((statement) => ({ ...statement, params: [...statement.params] }));
    },
  };
}
