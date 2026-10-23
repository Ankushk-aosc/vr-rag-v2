/**
 * Safe Audio Service
 * Gracefully wraps Expo audio recording and playback.
 * If the current Expo Go client lacks native ExponentAV,
 * it safely falls back without crashing the app.
 */

let ExpoAudio: any = null;

try {
  // Dynamically require expo-av inside try/catch to prevent launch crashes
  // when running on modern Expo Go clients where ExponentAV is excluded
  const expoAv = require("expo-av");
  ExpoAudio = expoAv?.Audio || null;
} catch (err) {
  console.warn("[AudioService] Native ExponentAV not available in this client:", err);
}

export function isAudioAvailable(): boolean {
  return ExpoAudio !== null;
}

export async function requestAudioPermissions(): Promise<boolean> {
  if (!ExpoAudio) return false;
  try {
    const res = await ExpoAudio.requestPermissionsAsync();
    await ExpoAudio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    return res.status === "granted";
  } catch (err) {
    console.warn("[AudioService] Failed to request permissions:", err);
    return false;
  }
}

export async function startRecording(): Promise<any | null> {
  if (!ExpoAudio) return null;
  try {
    const { recording } = await ExpoAudio.Recording.createAsync(
      ExpoAudio.RecordingOptionsPresets.HIGH_QUALITY
    );
    return recording;
  } catch (err) {
    console.warn("[AudioService] startRecording error:", err);
    return null;
  }
}

export async function stopRecording(recording: any): Promise<string | null> {
  if (!recording) return null;
  try {
    await recording.stopAndUnloadAsync();
    return recording.getURI();
  } catch (err) {
    console.warn("[AudioService] stopRecording error:", err);
    return null;
  }
}

export async function playBase64Audio(base64String: string): Promise<void> {
  if (!ExpoAudio) return;
  try {
    const uri = `data:audio/mp3;base64,${base64String}`;
    const { sound } = await ExpoAudio.Sound.createAsync({ uri });
    await sound.playAsync();
  } catch (err) {
    console.warn("[AudioService] Playback error:", err);
  }
}
