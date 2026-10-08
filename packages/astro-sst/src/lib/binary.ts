// Types whose bodies are text. Any other body is passed on as bytes, so a type
// missing from a list, such as image/avif or video/mp4, can't be corrupted by
// decoding it as UTF-8.
const textTypes = [
  /^text\//,
  /[/+]json$/,
  /[/+]xml$/,
  /^application\/(javascript|ecmascript|x-www-form-urlencoded|graphql)$/,
];

export function isBinaryResponse(headers: Record<string, string>) {
  // An encoded body, such as a gzipped one, is bytes whatever its type.
  if (headers["content-encoding"]) return true;
  const type = headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (!type) return false;
  return !textTypes.some((textType) => textType.test(type));
}
