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
      /**
       * The version of each component the marker says the stage has in a 5.0
       * form, by type. A marker written before components had versions lists
       * only their types.
       */
      components?: Record<string, number> | string[];
      /** The types of the components the stage has. */
      types?: string[];
      /** The types it has only inside SST's components, which move with those. */
      nested?: string[];
      /** Whether nothing is deployed on the stage. */
      empty?: boolean;
    };
  };
}

export const {};
