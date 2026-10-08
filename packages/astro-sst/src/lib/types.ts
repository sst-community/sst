import type { Writable } from "stream";
import type { APIGatewayProxyEventV2, Callback, Context } from "aws-lambda";

export interface ResponseStream extends Writable {
  getBufferedData(): Buffer;
  setContentType(contentType: string): void;
}

export type RequestHandler = (
  event: APIGatewayProxyEventV2,
  streamResponse: ResponseStream,
  context?: Context,
  callback?: Callback
) => void | Promise<void>;

// Lambda's Node.js runtime provides this global to streaming handlers.
declare global {
  const awslambda: {
    streamifyResponse(handler: RequestHandler): RequestHandler;
    HttpResponseStream: {
      from(
        underlyingStream: ResponseStream,
        metadata: {
          statusCode: number;
          headers?: Record<string, string>;
          cookies?: string[];
        }
      ): ResponseStream;
    };
  };
}
