/**
 * Go starter rule catalog, installed by `revu init --lang go`.
 *
 * Every rule ships `status: proposed` and `blocking: false`: a starter catalog
 * earns the right to gate merges only after it has been seen on real diffs.
 */
export const GO_RULES: Record<string, string> = {
  'rules/security/SEC-001.md': `---
id: SEC-001
title: Never commit credentials, keys or tokens to source
domain: security
severity: critical
blocking: false
status: proposed
applies_to:
  - "cmd/**/*.go"
  - "internal/**/*.go"
  - "pkg/**/*.go"
  - "**/*_test.go"
exceptions: []
---

No password, API key, token, private key, or connection string containing a
password may appear as a literal in Go source — including test files, fixtures,
and example code. Credentials must be read at runtime from the environment or a
config loader. This rule has no exceptions because a credential committed once is
permanently readable in the repository's history by everyone who has ever cloned
it; rotating it is the only remedy, and rotation cannot happen if nobody notices
the commit.

## Violating

\`\`\`go
const dbPassword = "changeme"

func newClient() *api.Client {
	return api.New("sk-CHANGEME-PLACEHOLDER-DO-NOT-USE")
}
\`\`\`

## Compliant

\`\`\`go
func newClient() (*api.Client, error) {
	key := os.Getenv("ACME_API_KEY")
	if key == "" {
		return nil, errors.New("ACME_API_KEY is not set")
	}
	return api.New(key), nil
}
\`\`\`

## How to fix

Read the value from the environment or the config struct and fail loudly at
startup when it is missing. In tests, inject a value via \`t.Setenv\` or a test
double rather than a literal, and treat any credential already committed as
compromised — rotate it, don't just delete the line.

`,

  'rules/security/SEC-002.md': `---
id: SEC-002
title: Build SQL with placeholders, never string concatenation
domain: security
severity: critical
blocking: false
status: proposed
applies_to:
  - "cmd/**/*.go"
  - "internal/**/*.go"
  - "pkg/**/*.go"
exceptions:
  - "**/*_test.go"
  - "**/migrations/**"
  - "**/*.pb.go"
---

A SQL statement passed to \`database/sql\` must be a constant string using driver
placeholders (\`$1\`, \`?\`), with every caller-supplied value passed as a query
argument. Any query assembled with \`fmt.Sprintf\`, \`+\`, \`strings.Builder\`, or
\`text/template\` over a parameter, struct field, or request value is a violation,
even when the value "looks safe" — validation upstream is not a substitute for
parameterization, and the two drift apart over time. This rule is about how the
query *string* is constructed; where the query is *executed* (for example inside
a loop) is PERF-001 and must not be reported here.

## Violating

\`\`\`go
func (s *Store) ByEmail(ctx context.Context, email string) (*User, error) {
	q := fmt.Sprintf("SELECT id, email FROM users WHERE email = '%s'", email)
	rows, err := s.db.QueryContext(ctx, q)
	...
}
\`\`\`

## Compliant

\`\`\`go
const qByEmail = "SELECT id, email FROM users WHERE email = $1"

func (s *Store) ByEmail(ctx context.Context, email string) (*User, error) {
	rows, err := s.db.QueryContext(ctx, qByEmail, email)
	...
}
\`\`\`

## How to fix

Move the statement into a package-level constant with \`$1\`-style placeholders and
pass the values as arguments to \`QueryContext\`/\`ExecContext\`. When the variable
part is an identifier that cannot be a placeholder (table or column name), select
it from a hardcoded allowlist map rather than interpolating the input.

`,

  'rules/reliability/REL-001.md': `---
id: REL-001
title: Library code returns errors instead of exiting the process
domain: reliability
severity: high
blocking: false
status: proposed
applies_to:
  - "cmd/**/*.go"
  - "internal/**/*.go"
  - "pkg/**/*.go"
exceptions:
  - "cmd/*/main.go"
  - "**/*_test.go"
  - "**/*.pb.go"
---

Outside \`cmd/*/main.go\`, a function must not call \`log.Fatal\`/\`log.Fatalf\`/\`log.Fatalln\`,
\`os.Exit\`, or \`panic\` on an error path; it must return an error to its caller
instead. These calls terminate the process immediately: deferred \`Close\` and
\`Rollback\` calls never run, in-flight requests are dropped instead of drained, and
no caller — including a test — can handle or even observe the failure. Only \`main\`
knows whether a failure is fatal for the program. This rule fires only when the
error path terminates the process; if the function returns the error, the quality
of that return is REL-002's concern, not this rule's.

## Violating

\`\`\`go
// internal/storage/postgres.go
func Open(dsn string) *sql.DB {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err) // kills the process from inside a library
	}
	return db
}
\`\`\`

## Compliant

\`\`\`go
// internal/storage/postgres.go
func Open(dsn string) (*sql.DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	return db, nil
}
\`\`\`

## How to fix

Change the signature to return an error and let \`main\` decide whether to exit.
When returning the result of \`http.Server.ListenAndServe\`/\`Serve\`, treat
\`http.ErrServerClosed\` as a normal shutdown and do not surface it:
\`if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) { return fmt.Errorf("http serve: %w", err) }\`.
Reserve \`panic\` for programmer errors that can never occur at runtime, such as a
failed \`regexp.MustCompile\` at package init.

`,

  'rules/reliability/REL-002.md': `---
id: REL-002
title: Wrap errors crossing an external boundary with %w
domain: reliability
severity: high
blocking: false
status: proposed
applies_to:
  - "internal/**/*.go"
  - "pkg/**/*.go"
exceptions:
  - "**/*_test.go"
  - "**/*.pb.go"
  - "**/mock_*.go"
---

The first function that calls an external dependency — \`database/sql\`, \`os\`/\`io\`,
\`net/http\`, an SDK, or a message-broker client — must wrap the returned error with
\`fmt.Errorf("<operation> <identifier>: %w", err)\` before returning it. A naked
\`return err\` from that frame yields messages like \`sql: no rows in result set\` or
\`connection refused\` with no indication of which query, file, URL, or key was
involved, which makes production failures unattributable. Wrapping is **not**
required when the function created the error itself with \`errors.New\`/\`fmt.Errorf\`,
when it is forwarding an error from another function in the same package that
already wrapped it, or when it is returning a package sentinel that callers match
with \`errors.Is\`. This rule assumes the error is returned; a function that exits
the process instead is REL-001.

## Violating

\`\`\`go
// internal/user/store.go — first Go frame over database/sql
func (s *Store) ByID(ctx context.Context, id int64) (*User, error) {
	var u User
	if err := s.db.QueryRowContext(ctx, qByID, id).Scan(&u.ID, &u.Email); err != nil {
		return nil, err // which query? which id? unknowable from the log line
	}
	return &u, nil
}
\`\`\`

## Compliant

\`\`\`go
func (s *Store) ByID(ctx context.Context, id int64) (*User, error) {
	var u User
	if err := s.db.QueryRowContext(ctx, qByID, id).Scan(&u.ID, &u.Email); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("user %d: %w", id, ErrNotFound)
		}
		return nil, fmt.Errorf("query user %d: %w", id, err)
	}
	return &u, nil
}
\`\`\`

## How to fix

Wrap with \`fmt.Errorf\` using \`%w\` and a message naming the operation and the
identifier involved; use \`%w\` rather than \`%v\` so callers can still use
\`errors.Is\`/\`errors.As\`. Do not repeat the same context at every layer — wrap once
at the boundary, then let intermediate frames forward it unchanged.

`,

  'rules/reliability/REL-003.md': `---
id: REL-003
title: Propagate context.Context through every I/O call
domain: reliability
severity: medium
blocking: false
status: proposed
applies_to:
  - "internal/**/*.go"
  - "pkg/**/*.go"
exceptions:
  - "**/*_test.go"
  - "cmd/*/main.go"
  - "**/*.pb.go"
---

Any exported function that performs I/O (database, HTTP, RPC, queue, or file
access with a context-aware API) must take \`ctx context.Context\` as its first
parameter and pass it down to the call that blocks. Inside a request path, calling
\`context.Background()\` or \`context.TODO()\` severs cancellation and the deadline, so
work continues after the client has disconnected and slow dependencies pile up
until the process runs out of connections. A goroutine started per request must
select on \`ctx.Done()\` or receive a context derived from the request's.

## Violating

\`\`\`go
func (s *Service) Sync(ctx context.Context, id string) error {
	go s.refreshCache(id) // never cancelled; leaks one goroutine per request
	return s.repo.Save(context.Background(), id) // deadline and cancellation dropped
}
\`\`\`

## Compliant

\`\`\`go
func (s *Service) Sync(ctx context.Context, id string) error {
	if err := s.repo.Save(ctx, id); err != nil {
		return fmt.Errorf("save %s: %w", id, err)
	}
	bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	go func() { defer cancel(); s.refreshCache(bg, id) }()
	return nil
}
\`\`\`

## How to fix

Add \`ctx context.Context\` as the first parameter and thread it to the \`...Context\`
variant of the call (\`QueryContext\`, \`http.NewRequestWithContext\`). Create a root
context only in \`main\` or in a test. For work that must outlive the request, derive
it with \`context.WithoutCancel\` plus an explicit \`context.WithTimeout\` rather than
\`context.Background()\`, so it still terminates.

`,

  'rules/architecture/ARCH-001.md': `---
id: ARCH-001
title: Depend on interfaces declared by the consumer
domain: architecture
severity: high
blocking: false
status: proposed
applies_to:
  - "internal/**/*.go"
  - "pkg/**/*.go"
exceptions:
  - "cmd/**"
  - "internal/app/**"
  - "internal/postgres/**"
  - "internal/storage/**"
  - "internal/adapters/**"
  - "**/*_test.go"
  - "**/*.pb.go"
---

Transport and service packages must depend on an interface declared in the package
that *uses* it, and must not import a concrete infrastructure package (storage,
HTTP client, queue) merely to name a struct field, parameter, or return type.
Importing the concrete type welds the caller to one implementation: swapping
Postgres for another store, or testing the handler without a live database, then
requires editing the handler. Interfaces belong at the consumer, sized to what that
consumer actually calls — not a mirror of the implementation's full method set.
Composition roots (\`cmd/\`, \`internal/app/\`) are exempt because that is precisely
where concrete types are chosen and injected.

## Violating

\`\`\`go
// internal/http/user_handler.go
import "github.com/acme/app/internal/postgres"

type UserHandler struct {
	store *postgres.UserStore // handler now depends on Postgres directly
}
\`\`\`

## Compliant

\`\`\`go
// internal/http/user_handler.go — interface declared where it is consumed
type UserStore interface {
	ByID(ctx context.Context, id int64) (*user.User, error)
}

type UserHandler struct {
	store UserStore
}
\`\`\`

## How to fix

Declare a minimal interface in the consuming package containing only the methods
that package calls, accept it in the constructor, and wire the concrete
implementation in \`cmd/\` or \`internal/app/\`. Delete the now-unused import of the
infrastructure package.

`,

  'rules/testing/TEST-001.md': `---
id: TEST-001
title: Ship a test with new or changed exported behavior
domain: testing
severity: high
blocking: false
status: proposed
applies_to:
  - "internal/**/*.go"
  - "pkg/**/*.go"
exceptions:
  - "**/*_test.go"
  - "cmd/**"
  - "internal/app/**"
  - "**/*.pb.go"
  - "**/*_gen.go"
  - "**/zz_generated*.go"
  - "**/mock_*.go"
  - "**/testdata/**"
---

When a change adds an exported function or method, or changes the behavior of an
existing one (new branch, new error case, altered return value), the same change
must add or update a test in the corresponding \`_test.go\` file that exercises the
new behavior. A test landing "in a follow-up" never constrains the code that was
written without it. Prefer table-driven tests with named subtests and \`t.Run\`, so
cases are added by appending a row. This rule does not fire on pure signature
renames with no behavior change, on unexported helpers, or on wiring code, which is
exempted by path above.

## Violating

\`\`\`go
// internal/pricing/discount.go — added in this change, no discount_test.go touched
func ApplyDiscount(total int64, tier Tier) int64 {
	if tier == TierGold {
		return total * 90 / 100
	}
	return total
}
\`\`\`

## Compliant

\`\`\`go
// internal/pricing/discount_test.go
func TestApplyDiscount(t *testing.T) {
	cases := map[string]struct{ total int64; tier Tier; want int64 }{
		"gold gets 10 percent off": {1000, TierGold, 900},
		"basic pays full price":    {1000, TierBasic, 1000},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := ApplyDiscount(tc.total, tc.tier); got != tc.want {
				t.Errorf("got %d, want %d", got, tc.want)
			}
		})
	}
}
\`\`\`

## How to fix

Add a table-driven test in the matching \`_test.go\` file next to the changed source
file covering the happy path and each new error or branch, including boundary
values. If the behavior is genuinely untestable without a live dependency, extract
the decision into a pure function and test that.

`,

  'rules/performance/PERF-001.md': `---
id: PERF-001
title: No database queries inside a loop
domain: performance
severity: medium
blocking: false
status: proposed
applies_to:
  - "internal/**/*.go"
  - "pkg/**/*.go"
exceptions:
  - "**/*_test.go"
  - "**/migrations/**"
  - "**/testdata/**"
  - "**/*.pb.go"
---

A call to \`QueryContext\`, \`QueryRowContext\`, \`ExecContext\`, or a repository method
that issues a query must not appear inside a \`for\`/\`range\` body: cost then grows
linearly with the collection and each iteration pays a full network round trip.
Resolve the whole set in one query — \`WHERE id = ANY($1)\` or a join — and correlate
the results in Go with a map. Conversely, filtering or aggregating in a Go loop over
a deliberately broad result set (\`SELECT *\` then \`if row.Status == ...\`) is the same
defect inverted and also violates this rule. This rule is about query *placement and
count*; how the SQL string is built is SEC-002 and must not be reported here.

## Violating

\`\`\`go
for _, o := range orders {
	var name string
	err := db.QueryRowContext(ctx, qUserName, o.UserID).Scan(&name)
	if err != nil {
		return fmt.Errorf("load user %d: %w", o.UserID, err)
	}
	o.UserName = name
}
\`\`\`

## Compliant

\`\`\`go
rows, err := db.QueryContext(ctx, qUserNamesByIDs, pq.Array(userIDs))
if err != nil {
	return fmt.Errorf("load users: %w", err)
}
names := make(map[int64]string, len(userIDs))
// scan rows into names, then:
for _, o := range orders {
	o.UserName = names[o.UserID]
}
\`\`\`

## How to fix

Collect the identifiers first, issue one set-based query (\`ANY\`, \`IN\`, or a join),
index the results into a map, then loop in memory. Push \`WHERE\`, \`ORDER BY\`,
\`LIMIT\`, and aggregates into SQL instead of fetching a broad result set and
reducing it in Go.

`,

  'rules/company-standards/STD-001.md': `---
id: STD-001
title: Log through the injected slog.Logger with structured attributes
domain: company-standards
severity: medium
blocking: false
status: proposed
applies_to:
  - "cmd/**/*.go"
  - "internal/**/*.go"
  - "pkg/**/*.go"
exceptions:
  - "cmd/*/main.go"
  - "**/*_test.go"
  - "**/testdata/**"
  - "**/*.pb.go"
---

All logging goes through the \`*slog.Logger\` injected into the type, using typed
attributes (\`slog.String\`, \`slog.Int64\`, \`slog.Any("error", err)\`) rather than a
formatted message. \`fmt.Println\`, \`print\`, \`log.Printf\`, and the \`log\` package's
default logger are violations: they bypass level filtering and the configured
handler, and produce lines that cannot be queried by field in the log backend.
Never pass a password, token, API key, \`Authorization\` header value, or full DSN as
an attribute value or inside a formatted message — log the host and database name
instead. The only exempt file is \`cmd/*/main.go\`, where bootstrap output may precede
logger construction; a file in a \`cmd/<name>/<subpackage>/\` directory is *not*
exempt.

## Violating

\`\`\`go
func (s *Service) Connect(ctx context.Context, dsn string) error {
	log.Printf("connecting to %s", dsn) // unstructured, and leaks the password
	fmt.Println("connected")
	return nil
}
\`\`\`

## Compliant

\`\`\`go
func (s *Service) Connect(ctx context.Context, cfg Config) error {
	s.log.InfoContext(ctx, "connecting to database",
		slog.String("host", cfg.Host), slog.String("database", cfg.Name))
	if err := s.pool.Ping(ctx); err != nil {
		s.log.ErrorContext(ctx, "database ping failed", slog.Any("error", err))
		return fmt.Errorf("ping %s: %w", cfg.Host, err)
	}
	return nil
}
\`\`\`

## How to fix

Accept a \`*slog.Logger\` in the constructor, store it on the struct, and replace
print/\`log\` calls with \`InfoContext\`/\`ErrorContext\` plus typed attributes. Split any
DSN or credential-bearing string into safe fields before logging it, or omit it
entirely.

`,

  'rules/documentation/DOC-001.md': `---
id: DOC-001
title: Document exported identifiers starting with their own name
domain: documentation
severity: low
blocking: false
status: proposed
applies_to:
  - "pkg/**/*.go"
  - "internal/**/*.go"
exceptions:
  - "**/*_test.go"
  - "**/*.pb.go"
  - "**/*_gen.go"
  - "**/zz_generated*.go"
  - "**/mock_*.go"
  - "**/testdata/**"
---

An exported identifier added or renamed in this change must have a doc comment
immediately above it that begins with the identifier's own name — \`// Store loads
and persists users.\`, not \`// This struct is for users.\` — because \`go doc\` and
pkg.go.dev render the comment as a standalone sentence about that symbol. Exported
interfaces additionally must state the contract implementations are held to: what
the method returns when nothing is found, which errors callers can match with
\`errors.Is\`, and whether the implementation must be safe for concurrent use. This
rule fires only on identifiers added or renamed by the change under review — never
on pre-existing undocumented code, on unexported identifiers, on struct fields, or
on methods that implement an already-documented interface.

## Violating

\`\`\`go
// pkg/store/store.go
// interface for users
type UserStore interface {
	ByID(ctx context.Context, id int64) (*User, error)
}
\`\`\`

## Compliant

\`\`\`go
// pkg/store/store.go

// UserStore reads users from durable storage.
// Implementations must be safe for concurrent use.
type UserStore interface {
	// ByID returns the user with the given id, or an error matching
	// ErrNotFound if no such user exists.
	ByID(ctx context.Context, id int64) (*User, error)
}
\`\`\`

## How to fix

Start the comment with the identifier's name and one sentence in the present tense
describing what it does. For interfaces, add the not-found error, the concurrency
guarantee, and any ownership rule for returned values, so implementers and callers
agree without reading an implementation.
`,
};
