export type ItchPlatform = "linux" | "windows" | "osx" | "android";

const itchPlatforms = {
  linux: "Linux", // we hardly GNU you
  windows: "Windows",
  osx: "macOS", // since WWDC june 2016
  android: "Android",
};

/**
 * Formats a platform for humans to read.
 */
export function formatItchPlatform(p: ItchPlatform): string {
  return itchPlatforms[p] || p;
}
