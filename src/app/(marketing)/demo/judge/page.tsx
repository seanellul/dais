export default function SampleJudge() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <p className="mb-4 text-sm uppercase tracking-widest">Try Dais on your phone</p>
      <h1 className="mb-5 text-4xl font-semibold">Judge a sample room</h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Your private demo has fictional teams and three rounds ready to score. No codes or
        installation needed — start judging here in your browser.
      </p>
      <form method="post" action="/demo?mode=judge">
        <button className="min-h-12 rounded-lg bg-primary px-6 py-3 text-primary-foreground">
          Start judging
        </button>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">
        Demo data expires after 24 hours. Your real tournaments are separate.
      </p>
    </div>
  );
}
