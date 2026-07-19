export function firePipeline(run: () => Promise<unknown>, label: string): void {
  void run().catch((err) => console.error(label, err));
}
