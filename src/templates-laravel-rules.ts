/**
 * Laravel starter rule catalog, installed by `revu init --lang laravel`.
 *
 * Every rule ships `status: proposed` and `blocking: false`: a starter catalog
 * earns the right to gate merges only after it has been seen on real diffs.
 */
export const LARAVEL_RULES: Record<string, string> = {
  'rules/security/SEC-001.md': `---
id: SEC-001
title: Never commit credentials, keys or tokens to source
domain: security
severity: critical
blocking: false
status: proposed
applies_to:
  - "app/**/*.php"
  - "config/**/*.php"
  - "routes/**/*.php"
  - "tests/**/*.php"
exceptions: []
---

No password, API key, token, or connection string containing a password may
appear as a literal in PHP source — including config files, tests, and seeders.
Credentials belong in the environment, read through \`config()\` at runtime. This
rule has no exceptions because a credential committed once is permanently
readable in the repository's history by everyone who has ever cloned it;
rotating it is the only remedy, and rotation cannot happen if nobody notices the
commit.

Config files are the most common offender: \`config/services.php\` is committed,
so a default value written there is a committed secret even though the same key
read from \`.env\` would not be.

## Violating

\`\`\`php
// config/services.php
return [
    'stripe' => [
        'secret' => 'sk-CHANGEME-PLACEHOLDER-DO-NOT-USE',
    ],
];
\`\`\`

## Compliant

\`\`\`php
// config/services.php
return [
    'stripe' => [
        'secret' => env('STRIPE_SECRET'),
    ],
];
\`\`\`

## How to fix

Move the value to \`.env\`, read it with \`env()\` inside \`config/\` only, and
reference it everywhere else through \`config('services.stripe.secret')\` so it
keeps working once configuration is cached. Add the key to \`.env.example\` with
an empty value so the requirement is discoverable. Treat any credential already
committed as compromised — rotate it, don't just delete the line.

`,

  'rules/security/SEC-002.md': `---
id: SEC-002
title: Never render user-controlled data through unescaped Blade output
domain: security
severity: high
blocking: false
status: proposed
applies_to:
  - "resources/views/**/*.blade.php"
exceptions: []
---

\`{{ }}\` runs its value through \`e()\` and is safe by default. \`{!! !!}\` does not
escape, so any user-controlled value rendered through it is stored XSS: a script
tag saved in a bio, a comment, or a product description executes in the browser
of every other user who views the page, under their session.

Unescaped output is legitimate for HTML your application generated itself — a
rendered Markdown block that has already been sanitised, or a component's own
markup. It is never legitimate for a value that arrived from a request.

## Violating

\`\`\`blade
<div class="bio">{!! $user->bio !!}</div>
\`\`\`

## Compliant

\`\`\`blade
<div class="bio">{{ $user->bio }}</div>
\`\`\`

When the value genuinely must carry HTML, sanitise it on the way in and mark it
explicitly at the point of render:

\`\`\`blade
{{-- $post->rendered_html is produced by the Markdown pipeline and purified on save --}}
<article>{!! $post->rendered_html !!}</article>
\`\`\`

## How to fix

Switch to \`{{ }}\`. If the field is meant to hold HTML, sanitise it when it is
written rather than when it is displayed — run it through an allow-list purifier
in the form request or the model mutator, store the safe version, and leave a
comment at the \`{!! !!}\` site naming what guarantees it is safe. Auditing one
write path is tractable; auditing every read path is not.

`,

  'rules/security/SEC-003.md': `---
id: SEC-003
title: Every route action authorizes before it acts
domain: security
severity: high
blocking: false
status: proposed
applies_to:
  - "app/Http/Controllers/**/*.php"
  - "routes/**/*.php"
exceptions: []
---

Authentication establishes who is calling; authorization establishes whether
this caller may touch this record. A controller action that loads a model by an
id from the request and acts on it without an authorization check lets any
logged-in user operate on any other user's data by changing a number in the URL.

The \`auth\` middleware does not satisfy this rule. It proves the caller is
somebody, not that they are the right somebody.

## Violating

\`\`\`php
public function update(Request $request, Order $order)
{
    $order->update($request->validated());

    return redirect()->route('orders.show', $order);
}
\`\`\`

## Compliant

\`\`\`php
public function update(UpdateOrderRequest $request, Order $order)
{
    $this->authorize('update', $order);

    $order->update($request->validated());

    return redirect()->route('orders.show', $order);
}
\`\`\`

## How to fix

Write a policy for the model (\`php artisan make:policy OrderPolicy --model=Order\`)
and call \`$this->authorize()\` as the first statement of the action, or type-hint
a form request whose \`authorize()\` performs the check. For a resource controller
that maps cleanly to a policy, \`$this->authorizeResource(Order::class, 'order')\`
in the constructor covers every action at once. Scoping the query to the caller
(\`$request->user()->orders()->findOrFail($id)\`) is an acceptable alternative when
ownership is the entire rule.

`,

  'rules/eloquent/ELO-001.md': `---
id: ELO-001
title: Eager load relations that are accessed in a loop
domain: eloquent
severity: high
blocking: false
status: proposed
applies_to:
  - "app/**/*.php"
  - "resources/views/**/*.blade.php"
exceptions: []
---

Accessing a relation inside a loop issues one query per iteration. Fifty posts
become fifty-one queries — the N+1 problem, and the single most common cause of
a Laravel page that is fast in development against ten rows and unusable in
production against ten thousand.

Lazy loading makes this invisible at the call site: \`$post->author->name\` reads
like a property access and behaves like a database round trip. The cost only
appears under real data volume, which is why it needs to be caught in review
rather than in staging.

## Violating

\`\`\`php
$posts = Post::latest()->take(50)->get();

foreach ($posts as $post) {
    // One SELECT against users per post.
    echo $post->author->name;
}
\`\`\`

## Compliant

\`\`\`php
$posts = Post::with('author')->latest()->take(50)->get();

foreach ($posts as $post) {
    echo $post->author->name;
}
\`\`\`

## How to fix

Add \`with()\` naming every relation the loop or view touches, including nested
ones (\`with('author.profile')\`). When you only need an aggregate, use
\`withCount('comments')\` rather than loading the full relation. To catch these
before review, enable \`Model::preventLazyLoading()\` in \`AppServiceProvider::boot()\`
for non-production environments — it turns a silent N+1 into an exception the
first time a test hits it.

`,

  'rules/eloquent/ELO-002.md': `---
id: ELO-002
title: Never mass-assign unvalidated request input
domain: eloquent
severity: critical
blocking: false
status: proposed
applies_to:
  - "app/Models/**/*.php"
  - "app/Http/Controllers/**/*.php"
exceptions: []
---

\`$guarded = []\` disables mass-assignment protection entirely. Combined with
\`Model::create($request->all())\`, it lets a caller set any column on the table by
adding a field to the request body — \`is_admin\`, \`account_balance\`, \`user_id\`,
\`email_verified_at\`. The vulnerability is invisible at the call site: the code
looks like it assigns the fields in the form, and it assigns whatever was sent.

The fix is two independent guards, and both are worth having: an allow-list on
the model, and validated data rather than raw input at the call site.

## Violating

\`\`\`php
class User extends Model
{
    protected $guarded = [];
}

// Anything in the request body becomes a column write.
User::create($request->all());
\`\`\`

## Compliant

\`\`\`php
class User extends Model
{
    protected $fillable = ['name', 'email'];
}

// validated() returns only the keys the form request declared rules for.
User::create($request->validated());
\`\`\`

## How to fix

Declare \`$fillable\` with the columns a client is genuinely allowed to set, and
pass \`$request->validated()\` — never \`$request->all()\` — into \`create()\`,
\`update()\`, and \`fill()\`. Set privileged columns explicitly and separately after
the mass assignment, where an authorization check can sit next to them.

`,

  'rules/eloquent/ELO-003.md': `---
id: ELO-003
title: Never interpolate input into a raw query
domain: eloquent
severity: critical
blocking: false
status: proposed
applies_to:
  - "app/**/*.php"
  - "database/**/*.php"
exceptions: []
---

The query builder parameterises its values, so \`where('email', $email)\` is safe
no matter what \`$email\` contains. The raw escape hatches — \`whereRaw\`,
\`selectRaw\`, \`orderByRaw\`, \`havingRaw\`, \`DB::raw\`, \`DB::statement\` — do not.
String-interpolating a request value into any of them is SQL injection.

Raw expressions are legitimate for SQL the builder cannot express. They are
never legitimate as a way to splice in a value.

## Violating

\`\`\`php
$search = $request->input('q');

$users = DB::table('users')
    ->whereRaw("name LIKE '%{$search}%'")
    ->get();
\`\`\`

## Compliant

\`\`\`php
$search = $request->input('q');

$users = DB::table('users')
    ->whereRaw('name LIKE ?', ['%' . $search . '%'])
    ->get();
\`\`\`

## How to fix

Move every value out of the SQL string and into the bindings array. If the
dynamic part is an identifier rather than a value — a sortable column, a
direction — bindings cannot help: validate it against an explicit allow-list of
permitted column names before it reaches the query, and reject anything else.

`,

  'rules/eloquent/ELO-004.md': `---
id: ELO-004
title: Every migration has a working down()
domain: eloquent
severity: high
blocking: false
status: proposed
applies_to:
  - "database/migrations/**/*.php"
exceptions: []
---

An empty or missing \`down()\` makes the migration a one-way door. \`migrate:rollback\`
reports success and changes nothing, which is worse than failing: a deploy that
goes wrong cannot be reversed, and every developer whose local database is on the
wrong side of the migration has to drop and reseed.

The \`down()\` must actually reverse the \`up()\` — dropping the column that was
added, restoring the type that was changed — not merely exist.

## Violating

\`\`\`php
public function up(): void
{
    Schema::table('orders', function (Blueprint $table) {
        $table->string('tracking_code')->nullable();
    });
}

public function down(): void
{
    //
}
\`\`\`

## Compliant

\`\`\`php
public function up(): void
{
    Schema::table('orders', function (Blueprint $table) {
        $table->string('tracking_code')->nullable();
    });
}

public function down(): void
{
    Schema::table('orders', function (Blueprint $table) {
        $table->dropColumn('tracking_code');
    });
}
\`\`\`

## How to fix

Write the inverse operation and test it: run \`php artisan migrate\` followed by
\`php artisan migrate:rollback\` and confirm the schema returns to its previous
shape. When a migration is genuinely irreversible — a destructive data
transformation with no inverse — say so in \`down()\` by throwing with an
explanation, so a rollback fails loudly instead of silently doing nothing.

`,

  'rules/architecture/ARCH-001.md': `---
id: ARCH-001
title: Controllers coordinate, they do not contain business logic
domain: architecture
severity: medium
blocking: false
status: proposed
applies_to:
  - "app/Http/Controllers/**/*.php"
exceptions: []
---

A controller action's job is to translate an HTTP request into a call and a
response. When pricing rules, state machines, or multi-step workflows live in the
action body, they can only be exercised through an HTTP request, they cannot be
reused by a console command or a queued job, and the action grows until nobody
can tell which branch handles which case.

The test for this rule is reuse, not line count: logic that a job or a command
would also need does not belong in a controller.

## Violating

\`\`\`php
public function store(StoreOrderRequest $request)
{
    $order = Order::create($request->validated());

    $total = 0;
    foreach ($order->items as $item) {
        $total += $item->price * $item->quantity;
    }
    if ($order->user->isPremium()) {
        $total *= 0.9;
    }
    $order->update(['total' => $total]);

    Mail::to($order->user)->send(new OrderPlaced($order));

    return redirect()->route('orders.show', $order);
}
\`\`\`

## Compliant

\`\`\`php
public function store(StoreOrderRequest $request, PlaceOrder $placeOrder)
{
    $order = $placeOrder->handle($request->user(), $request->validated());

    return redirect()->route('orders.show', $order);
}
\`\`\`

## How to fix

Extract the work into a single-purpose action or service class
(\`app/Actions/PlaceOrder.php\`) with one public method, and inject it into the
controller. The action becomes unit-testable without an HTTP request and reusable
from a command or a job. Leave request translation and the response in the
controller.

`,

  'rules/testing/TEST-001.md': `---
id: TEST-001
title: A new route ships with a feature test
domain: testing
severity: medium
blocking: false
status: proposed
applies_to:
  - "routes/**/*.php"
  - "app/Http/Controllers/**/*.php"
exceptions: []
---

A route added without a test is a route nobody has proven is reachable, returns
the status it claims, or refuses the users it should refuse. Feature tests in
Laravel are cheap — they boot the framework, hit the route, and assert on the
response — so the cost of the first test for an endpoint is small and the cost of
having none is a regression nobody catches.

At minimum the test asserts the success path and the authorization boundary. An
endpoint whose authorization is untested is an endpoint whose authorization will
eventually be removed by a refactor without anyone noticing.

## Violating

A new \`POST /orders\` route in \`routes/web.php\` with no corresponding test in
\`tests/Feature\`.

## Compliant

\`\`\`php
// tests/Feature/OrderTest.php
public function test_a_user_can_place_an_order(): void
{
    $user = User::factory()->create();

    $response = $this->actingAs($user)->post('/orders', [
        'product_id' => Product::factory()->create()->id,
        'quantity' => 2,
    ]);

    $response->assertRedirect();
    $this->assertDatabaseHas('orders', ['user_id' => $user->id]);
}

public function test_a_guest_cannot_place_an_order(): void
{
    $this->post('/orders', [])->assertRedirect('/login');
}
\`\`\`

## How to fix

Add a feature test covering the success path and the rejection path. Use model
factories rather than hand-built fixtures, assert on the database with
\`assertDatabaseHas\` rather than re-querying through the same code you are
testing, and name the test for the behaviour it protects.

`,

  'rules/performance/PERF-001.md': `---
id: PERF-001
title: Paginate collections that grow
domain: performance
severity: medium
blocking: false
status: proposed
applies_to:
  - "app/**/*.php"
exceptions: []
---

\`Model::all()\` and an unbounded \`get()\` load every matching row into memory and
hydrate a model object for each one. On a table that grows — orders, events, log
entries — this is fine on the day it is written and exhausts the PHP memory limit
some months later. The failure arrives without a code change, which makes it hard
to attribute.

Fixed reference tables (currencies, countries, roles) are the legitimate case for
loading everything, because their size is bounded by design.

## Violating

\`\`\`php
public function index()
{
    return view('orders.index', [
        'orders' => Order::all(),
    ]);
}
\`\`\`

## Compliant

\`\`\`php
public function index()
{
    return view('orders.index', [
        'orders' => Order::latest()->paginate(25),
    ]);
}
\`\`\`

## How to fix

Use \`paginate()\` for anything rendered in a view, and \`chunkById()\` or \`lazy()\`
for batch processing, so memory stays constant regardless of table size. Where
you genuinely need every row of a bounded table, leave a comment saying why the
bound holds.

`,

  'rules/company-standards/STD-001.md': `---
id: STD-001
title: Validate through a FormRequest, not inline in the action
domain: company-standards
severity: medium
blocking: false
status: proposed
applies_to:
  - "app/Http/Controllers/**/*.php"
  - "app/Http/Requests/**/*.php"
exceptions: []
---

Inline \`$request->validate([...])\` puts the contract of an endpoint in the middle
of its implementation. It cannot be reused between the store and update actions
that share a shape, it cannot be unit-tested on its own, and it leaves no
obvious home for the authorization check that belongs beside it.

A form request keeps rules, authorization, and any input normalisation in one
class named for the operation.

## Violating

\`\`\`php
public function store(Request $request)
{
    $data = $request->validate([
        'title' => 'required|string|max:255',
        'body' => 'required|string',
    ]);

    return Post::create($data);
}
\`\`\`

## Compliant

\`\`\`php
// app/Http/Requests/StorePostRequest.php
class StorePostRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('create', Post::class);
    }

    public function rules(): array
    {
        return [
            'title' => ['required', 'string', 'max:255'],
            'body' => ['required', 'string'],
        ];
    }
}

// app/Http/Controllers/PostController.php
public function store(StorePostRequest $request)
{
    return Post::create($request->validated());
}
\`\`\`

## How to fix

Generate one with \`php artisan make:request StorePostRequest\`, move the rules
across as arrays rather than pipe-delimited strings, implement \`authorize()\`, and
type-hint it in the action. Share a common rule set between store and update by
extracting a base request or a static \`rules()\` helper.

`,

  'rules/documentation/DOC-001.md': `---
id: DOC-001
title: Public endpoints and queued jobs carry a docblock
domain: documentation
severity: low
blocking: false
status: proposed
applies_to:
  - "app/Http/Controllers/**/*.php"
  - "app/Jobs/**/*.php"
exceptions: []
---

Controller actions and queued jobs are entry points: something outside the class
decides to run them, so the code that calls them is not next to them. A short
docblock stating what the operation does, what it expects, and how it behaves on
failure saves the next reader from reconstructing that from the body.

Queued jobs need this most. Their retry, timeout, and idempotency behaviour
determines what happens when they fail halfway, and none of it is visible from
the \`handle()\` body.

## Violating

\`\`\`php
class SyncInventory implements ShouldQueue
{
    public function handle(): void
    {
        // ...
    }
}
\`\`\`

## Compliant

\`\`\`php
/**
 * Pulls current stock levels from the supplier API and updates local inventory.
 *
 * Safe to retry: writes are keyed by SKU and last-write-wins, so a partial run
 * followed by a retry converges. Fails after 3 attempts and reports to the
 * failed_jobs table.
 */
class SyncInventory implements ShouldQueue
{
    public int $tries = 3;

    public function handle(): void
    {
        // ...
    }
}
\`\`\`

## How to fix

Add a docblock stating the operation's purpose, its expected input, and its
failure behaviour. For jobs, say explicitly whether a retry is safe and why —
that sentence is the one that matters at three in the morning. Skip the docblock
on actions whose name and signature already say everything (\`show(Post $post)\`);
this rule is about entry points with non-obvious behaviour, not about ceremony.

`,
};
