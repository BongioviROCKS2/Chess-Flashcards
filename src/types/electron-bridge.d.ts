export {};

declare global {
  interface Window {
    cardgen?: {
      saveConfig: (cfg: {
        otherAnswersAcceptance: number;
        maxOtherAnswerCount: number;
        depth: number;
        threads: number;
        hash: number;
      }) => Promise<boolean>;
      makeCard?: (args: {
        moves?: string;
        pgn?: string;
        fen?: string;
        config?: {
          otherAnswersAcceptance: number;
          maxOtherAnswerCount: number;
          depth: number;
          threads: number;
          hash: number;
        };
      }) => Promise<{ ok: boolean; message: string }>;
    };

    cards?: {
      readOne: (id: string) => Promise<any | null>;
      update: (card: any) => Promise<boolean>;
      create?: (card: any) => Promise<boolean>;
      setDue?: (id: string, due: string | 'new' | undefined) => Promise<boolean>;
      exportToDownloads?: () => Promise<{ ok: boolean; path?: string; message?: string }>;
    };

    zoom?: {
      getFactor: () => number;
      setFactor: (f: number) => number;
      in: (step?: number) => number;
      out: (step?: number) => number;
      reset: () => number;
    };
  }
}
