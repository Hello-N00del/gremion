/**
 * The largest file the Files page sends. Every file goes through the single PUT, whose request
 * body the app container caps with BODY_SIZE_LIMIT (docker-compose.app.yml, 100M): the two
 * numbers move together.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export function isUploadTooLarge(sizeBytes: number): boolean {
  return sizeBytes > MAX_UPLOAD_BYTES
}
