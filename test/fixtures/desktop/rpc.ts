export type Request =
  | { readonly method: "initialize"; readonly id: string | number }
  | {
      readonly method: "tools/call"
      readonly id: string | number
      readonly params: {
        readonly arguments: { readonly threadId: string; readonly prompt: string }
      }
    }
