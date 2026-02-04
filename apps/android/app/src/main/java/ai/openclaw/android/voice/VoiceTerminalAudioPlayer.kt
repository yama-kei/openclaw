package ai.openclaw.android.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

class VoiceTerminalAudioPlayer(private val context: Context) {
  suspend fun play(audioBytes: ByteArray): Long {
    return withContext(Dispatchers.IO) {
      val start = SystemClock.elapsedRealtime()
      Log.d("VoiceTerminal", "audio playback start")
      val wav = parseWav(audioBytes)
      if (wav != null && wav.audioFormat == 1 && wav.bitsPerSample == 16) {
        playPcm(wav)
      } else {
        playMediaPlayer(audioBytes)
      }
      val elapsed = SystemClock.elapsedRealtime() - start
      Log.d("VoiceTerminal", "audio playback end (${elapsed}ms)")
      elapsed
    }
  }

  private suspend fun playPcm(wav: WavInfo) {
    val channelMask =
      if (wav.channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
    val audioFormat =
      AudioFormat.Builder()
        .setSampleRate(wav.sampleRate)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setChannelMask(channelMask)
        .build()
    val attributes =
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    val pcmData = wav.data
    val track =
      AudioTrack.Builder()
        .setAudioAttributes(attributes)
        .setAudioFormat(audioFormat)
        .setBufferSizeInBytes(pcmData.size)
        .setTransferMode(AudioTrack.MODE_STATIC)
        .build()
    track.write(pcmData, 0, pcmData.size)
    track.play()

    val frames = pcmData.size / (wav.channels * (wav.bitsPerSample / 8))
    while (track.playbackHeadPosition < frames) {
      delay(20)
    }
    track.stop()
    track.release()
  }

  private fun playMediaPlayer(audioBytes: ByteArray) {
    val tempFile = File.createTempFile("voice-terminal-", ".audio", context.cacheDir)
    try {
      FileOutputStream(tempFile).use { it.write(audioBytes) }
      val player = MediaPlayer()
      try {
        player.setDataSource(tempFile.absolutePath)
        player.setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        player.prepare()
        player.start()
        while (player.isPlaying) {
          SystemClock.sleep(20)
        }
      } finally {
        player.release()
      }
    } finally {
      tempFile.delete()
    }
  }

  private data class WavInfo(
    val audioFormat: Int,
    val channels: Int,
    val sampleRate: Int,
    val bitsPerSample: Int,
    val data: ByteArray,
  )

  private fun parseWav(bytes: ByteArray): WavInfo? {
    if (bytes.size < 44) return null
    if (!bytes.copyOfRange(0, 4).contentEquals("RIFF".toByteArray())) return null
    if (!bytes.copyOfRange(8, 12).contentEquals("WAVE".toByteArray())) return null

    var offset = 12
    var audioFormat: Int? = null
    var channels: Int? = null
    var sampleRate: Int? = null
    var bitsPerSample: Int? = null
    var dataOffset: Int? = null
    var dataSize: Int? = null

    while (offset + 8 <= bytes.size) {
      val chunkId = String(bytes, offset, 4)
      val chunkSize = readIntLe(bytes, offset + 4)
      val chunkDataStart = offset + 8
      if (chunkId == "fmt " && chunkDataStart + 16 <= bytes.size) {
        audioFormat = readShortLe(bytes, chunkDataStart)
        channels = readShortLe(bytes, chunkDataStart + 2)
        sampleRate = readIntLe(bytes, chunkDataStart + 4)
        bitsPerSample = readShortLe(bytes, chunkDataStart + 14)
      } else if (chunkId == "data") {
        dataOffset = chunkDataStart
        dataSize = chunkSize
        break
      }
      offset = chunkDataStart + chunkSize
    }

    val fmt = audioFormat ?: return null
    val ch = channels ?: return null
    val rate = sampleRate ?: return null
    val bits = bitsPerSample ?: return null
    val dataStart = dataOffset ?: return null
    val dataLen = dataSize ?: return null
    if (dataStart + dataLen > bytes.size) return null
    val data = bytes.copyOfRange(dataStart, dataStart + dataLen)
    return WavInfo(fmt, ch, rate, bits, data)
  }

  private fun readIntLe(bytes: ByteArray, offset: Int): Int {
    return bytes[offset].toInt() and 0xFF or
      (bytes[offset + 1].toInt() and 0xFF shl 8) or
      (bytes[offset + 2].toInt() and 0xFF shl 16) or
      (bytes[offset + 3].toInt() and 0xFF shl 24)
  }

  private fun readShortLe(bytes: ByteArray, offset: Int): Int {
    return bytes[offset].toInt() and 0xFF or
      (bytes[offset + 1].toInt() and 0xFF shl 8)
  }
}
