/** Text-only auxiliary completion used to extract reusable graph nodes. */

export type CompleteFn = (system: string, user: string) => Promise<string>
