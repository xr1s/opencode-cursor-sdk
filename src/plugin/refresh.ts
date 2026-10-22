export class RefreshController {
  private running: Promise<void> | undefined

  constructor(private readonly refresh: () => Promise<void>) {}

  run(): Promise<void> {
    if (this.running) return this.running
    const current = this.refresh().finally(() => {
      if (this.running === current) this.running = undefined
    })
    this.running = current
    return current
  }
}
