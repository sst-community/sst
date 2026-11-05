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
      /** Whether the stage has moved to SST 5's components. */
      moved?: boolean;
      /**
       * The version of each component the marker says the stage has in a 5.0
       * form, by type, and of those inside SST's components by their type
       * after `>`. A marker written before components had versions lists
       * only their types.
       */
      components?: Record<string, number> | string[];
      /** The types of the components the stage has. */
      types?: string[];
      /** The types it has only inside SST's components, which move with those. */
      nested?: string[];
      /** Whether nothing is deployed on the stage. */
      empty?: boolean;
      /**
       * The id of each of SST 4's provider resources a move adopts, by its
       * name: the part in its place imports it. The state has them until a
       * move finishes.
       */
      adopt?: Record<string, string>;
    };
  };
}

export const {};
