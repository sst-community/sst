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
      /** Whether the stage has moved to SST 5's components. */
      moved?: boolean;
      /** The types of the components the marker says are in their 5.0 form. */
      components?: string[];
      /** The types of the components the stage has. */
      types?: string[];
      /** Whether nothing is deployed on the stage. */
      empty?: boolean;
    };
  };
}

export const {};
