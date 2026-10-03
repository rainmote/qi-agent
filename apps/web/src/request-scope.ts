/** A view can leave and return to the same session; its ID alone is not a request identity. */
export class RequestScope {
  private revision = 0;
  capture(): () => boolean {
    const revision = this.revision;
    return () => this.revision === revision;
  }
  advance(): () => boolean {
    this.revision += 1;
    return this.capture();
  }
}
