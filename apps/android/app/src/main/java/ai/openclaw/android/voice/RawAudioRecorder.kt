package ai.openclaw.android.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import kotlin.math.min

/**
 * Raw audio capture for Voice Terminal (HTTP voice webhook).
 *
 * This records mono PCM and returns WAV bytes for easy server compatibility.
 * SpeechRecognizer is intentionally avoided because the webhook expects raw audio.
 */
class RawAudioRecorder(private val context: Context) {
  companion object {
    const val sampleRateHz = 16000
    private const val channelCount = 1
    private const val bytesPerSample = 2
  }

  private var recorder: AudioRecord? = null
  private var bufferSizeBytes: Int = 0
  private var isRecording = false

  fun start() {
    ensureMicPermission()
    if (isRecording) return
    if (recorder == null) {
      recorder = buildRecorder()
    }
    recorder?.startRecording()
    isRecording = true
  }

  fun stop() {
    if (!isRecording) return
    recorder?.stop()
    isRecording = false
  }

  fun recordForMillis(durationMs: Long): ByteArray {
    start()
    try {
      val totalBytes =
        ((durationMs * sampleRateHz * bytesPerSample) / 1000L).toInt().coerceAtLeast(0)
      val pcmOut = ByteArrayOutputStream(totalBytes)
      val buffer = ByteArray(bufferSizeBytes)
      var remaining = totalBytes

      while (remaining > 0) {
        val readSize = min(buffer.size, remaining)
        val read = recorder?.read(buffer, 0, readSize) ?: 0
        if (read <= 0) {
          throw IllegalStateException("AudioRecord read failed: $read")
        }
        pcmOut.write(buffer, 0, read)
        remaining -= read
      }

      val pcmBytes = pcmOut.toByteArray()
      return wrapWav(pcmBytes)
    } finally {
      stop()
    }
  }

  private fun buildRecorder(): AudioRecord {
    val minBuffer =
      AudioRecord.getMinBufferSize(
        sampleRateHz,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    if (minBuffer <= 0) {
      throw IllegalStateException("AudioRecord init failed: invalid buffer size $minBuffer")
    }
    bufferSizeBytes = minBuffer
    val recorder =
      AudioRecord.Builder()
        .setAudioSource(MediaRecorder.AudioSource.MIC)
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRateHz)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build(),
        )
        .setBufferSizeInBytes(bufferSizeBytes)
        .build()
    if (recorder.state != AudioRecord.STATE_INITIALIZED) {
      recorder.release()
      throw IllegalStateException("AudioRecord init failed")
    }
    return recorder
  }

  private fun ensureMicPermission() {
    val granted =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!granted) {
      throw IllegalStateException("Microphone permission required")
    }
  }

  private fun wrapWav(pcm: ByteArray): ByteArray {
    val byteRate = sampleRateHz * channelCount * bytesPerSample
    val blockAlign = channelCount * bytesPerSample
    val dataSize = pcm.size
    val riffSize = 36 + dataSize
    val out = ByteArrayOutputStream(44 + dataSize)

    out.write("RIFF".toByteArray())
    writeIntLe(out, riffSize)
    out.write("WAVE".toByteArray())
    out.write("fmt ".toByteArray())
    writeIntLe(out, 16) // PCM header size
    writeShortLe(out, 1) // PCM format
    writeShortLe(out, channelCount)
    writeIntLe(out, sampleRateHz)
    writeIntLe(out, byteRate)
    writeShortLe(out, blockAlign)
    writeShortLe(out, bytesPerSample * 8)
    out.write("data".toByteArray())
    writeIntLe(out, dataSize)
    out.write(pcm)

    return out.toByteArray()
  }

  private fun writeIntLe(out: ByteArrayOutputStream, value: Int) {
    out.write(value and 0xFF)
    out.write(value shr 8 and 0xFF)
    out.write(value shr 16 and 0xFF)
    out.write(value shr 24 and 0xFF)
  }

  private fun writeShortLe(out: ByteArrayOutputStream, value: Int) {
    out.write(value and 0xFF)
    out.write(value shr 8 and 0xFF)
  }
}
