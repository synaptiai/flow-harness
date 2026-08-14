export const invalidUtf8PythonPackageMetadata = Buffer.concat([
  Buffer.from("Name: invalid-utf8\nVersion: 1.0.0\n"),
  Buffer.from([0xff]),
]);
