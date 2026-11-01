declare global {
  export const $cli: {
    command: string;
    rpc: string;
    contract?: number;
    paths: {
      home: string;
      root: string;
      work: string;
      platform: string;
    };
    home: string;
    state: {
      version: Record<string, number>;
    };
  };
}

export const {};
