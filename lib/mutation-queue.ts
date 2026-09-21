/** Serializes writes while allowing their optimistic UI updates to happen immediately. */
export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private pending = 0;
  private failed = false;

  private readonly reconcile: () => Promise<unknown>;

  constructor(reconcile: () => Promise<unknown>) { this.reconcile = reconcile; }

  isLatest(revision: number) { return revision === this.revision; }
  get version() { return this.revision; }

  enqueue<T>(write: (revision: number) => Promise<T>): Promise<T> {
    const revision = ++this.revision;
    this.pending += 1;
    const result = this.tail.then(() => write(revision));
    // This handler owns background recovery; the original promise still lets a
    // dialog stay open on failure instead of claiming a save succeeded.
    this.tail = result.then(() => {}, () => { this.failed = true; }).then(async () => {
      this.pending -= 1;
      if (this.pending === 0 && this.failed) {
        this.failed = false;
        await this.reconcile();
      }
    }).catch(() => {});
    return result;
  }
}
