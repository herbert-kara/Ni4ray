// Removed reference to vite/client as it was causing type definition errors.
// Removed conflicting `process` declaration. The environment (Node types) should provide this.

export {}; 

declare global {
  // Augment the NodeJS namespace if it exists, or just rely on existing types.
  // This avoids "redeclare block-scoped variable" errors.
  namespace NodeJS {
    interface ProcessEnv {
      API_KEY?: string;
      [key: string]: string | undefined;
    }
  }
}
