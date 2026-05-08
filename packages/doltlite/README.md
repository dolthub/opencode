# @dolthub/doltlite

Node.js native bindings for [DoltLite](https://github.com/dolthub/doltlite) — a SQLite fork that adds Git-style version control (branches, commits, merges, diffs, blame) to your SQL database.

## Install

```bash
npm install @dolthub/doltlite
# or
bun add @dolthub/doltlite
```

The install script downloads the DoltLite amalgamation for your package version and compiles the native addon via `node-gyp`. You need a C/C++ toolchain (`gcc`/`clang` + `make` on Linux/macOS, MSVC Build Tools on Windows) and Python 3.

## Drop-in compatibility with `node:sqlite`

`DatabaseSync` and `StatementSync` match the [Node.js `node:sqlite`](https://nodejs.org/api/sqlite.html) API, so you can switch by changing one import line:

```diff
-import { DatabaseSync } from "node:sqlite"
+import { DatabaseSync } from "@dolthub/doltlite"
```

## Basic usage

```ts
import { DatabaseSync } from "@dolthub/doltlite"

const db = new DatabaseSync("myapp.db")

db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)`)

const insert = db.prepare("INSERT INTO users (name) VALUES (?)")
insert.run("Alice")
insert.run("Bob")

const all = db.prepare("SELECT * FROM users")
console.log(all.all())
// [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]

db.close()
```

## Dolt version-control API

All Dolt features are exposed as methods on `DatabaseSync` under `dolt*` names. They are thin wrappers around Dolt's [SQL functions](https://docs.dolthub.com/sql-reference/version-control/dolt-sql-functions) so you can also call them directly via `db.exec("SELECT dolt_commit(...)")` if you prefer.

```ts
const db = new DatabaseSync("versioned.db")

db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, amount REAL)`)
db.exec(`INSERT INTO orders VALUES (1, 99.99)`)

// Commit the current state
const hash = db.doltCommit("initial data")
console.log(hash) // "abc123..."

// Branch and make changes
db.doltBranch("experiment")
db.doltCheckout("experiment")
db.exec(`INSERT INTO orders VALUES (2, 49.99)`)
db.doltCommit("add order 2")

// See what changed
console.log(db.doltStatus())
console.log(db.doltLog({ limit: 5 }))

// Merge back
db.doltCheckout("main")
const result = db.doltMerge("experiment")
console.log(result) // { fast_forward: 0, conflicts: 0 }

// Inspect history
console.log(db.doltDiff("HEAD~1", "HEAD", "orders"))
console.log(db.doltBlameOf("orders"))
console.log(db.doltHistoryOf("orders"))

// Tag a release
db.doltTag("v1.0.0")
console.log(db.doltTags())

db.close()
```

## API reference

### `new DatabaseSync(path, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `open` | boolean | `true` | Open immediately |
| `readOnly` | boolean | `false` | Read-only mode |

### node:sqlite-compatible methods

| Method | Description |
|--------|-------------|
| `exec(sql)` | Run SQL with no return value |
| `prepare(sql)` | Compile a `StatementSync` |
| `close()` | Close the connection |
| `open(path)` | (Re-)open at path |
| `location()` | Filesystem path or `null` |
| `createFunction(name, fn)` | Register a scalar UDF |
| `.isOpen` | `true` if connection is open |
| `.inTransaction` | `true` if inside a transaction |

### StatementSync

| Method | Returns |
|--------|---------|
| `run(...params)` | `{ changes, lastInsertRowid }` |
| `get(...params)` | First row object or `undefined` |
| `all(...params)` | All row objects |
| `iterate(...params)` | `IterableIterator` |
| `columns()` | Column metadata array |
| `.sourceSQL` | Original SQL text |
| `.expandedSQL` | SQL with parameters expanded |

### Dolt methods on `DatabaseSync`

| Method | Returns | Description |
|--------|---------|-------------|
| `doltCommit(message)` | `string` (hash) | Stage all + commit |
| `doltBranch(name, from?)` | `void` | Create branch |
| `doltCheckout(branch)` | `void` | Switch branch |
| `doltMerge(branch)` | `{fast_forward, conflicts}` | Merge branch |
| `doltReset(flag?)` | `void` | Reset HEAD (`"--hard"`) |
| `doltAdd(table?)` | `void` | Stage table(s) |
| `doltStatus()` | `DoltStatusEntry[]` | Working-set status |
| `doltLog(opts?)` | `DoltCommit[]` | Commit history |
| `doltBranches()` | `DoltBranchInfo[]` | All branches |
| `doltActiveBranch()` | `string` | Current branch name |
| `doltDiff(from, to, table)` | `DoltDiffRow[]` | Row-level diff |
| `doltHashOf(ref?)` | `string` | Content hash of DB at ref |
| `doltVersion()` | `string` | DoltLite version |
| `doltTag(name)` | `void` | Create tag at HEAD |
| `doltTags()` | `DoltTagInfo[]` | All tags |
| `doltHistoryOf(table)` | `object[]` | Full row history |
| `doltBlameOf(table)` | `object[]` | Per-row blame |
| `doltCherryPick(hash)` | `void` | Cherry-pick commit |
| `doltRevert(ref?)` | `void` | Revert commit |

## Building from source

```bash
git clone https://github.com/dolthub/doltlite
cd packages/doltlite
npm install        # downloads amalgamation + compiles
npm run build      # rebuild only
npm run build:debug  # debug build
```

## License

Apache 2.0 — see [DoltLite](https://github.com/dolthub/doltlite) for the underlying library license.
