export class RetryWindow {
  private available = true

  consume(): boolean {
    if (!this.available) return false
    this.available = false
    return true
  }
}
