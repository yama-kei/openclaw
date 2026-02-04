package ai.openclaw.android.voice

import android.util.Base64
import ai.openclaw.android.gateway.GatewayEndpoint
import ai.openclaw.android.gateway.GatewayTlsParams
import ai.openclaw.android.gateway.buildGatewayTlsConfig
import java.io.IOException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.IOException as OkioIOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

data class VoiceTerminalResponse(
  val text: String,
  val speak: Boolean,
  val ttsAudioBytes: ByteArray?,
)

class VoiceTerminalClient(
  private val endpoint: GatewayEndpoint,
  private val tlsParams: GatewayTlsParams?,
  private val onTlsFingerprint: ((String) -> Unit)? = null,
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val client: OkHttpClient = buildClient()

  fun sendVoice(
    sessionId: String,
    audioBytes: ByteArray,
  ): VoiceTerminalResponse {
    if (sessionId.trim().isEmpty()) {
      throw IllegalArgumentException("session_id is required")
    }
    val payload =
      buildJsonObject {
        put("session_id", JsonPrimitive(sessionId))
        put("audio_base64", JsonPrimitive(Base64.encodeToString(audioBytes, Base64.NO_WRAP)))
      }
    val body = payload.toString().toRequestBody(jsonMediaType)
    val request = Request.Builder().url(buildUrl()).post(body).build()
    val response =
      try {
        client.newCall(request).execute()
      } catch (err: OkioIOException) {
        throw IOException("Voice terminal request failed: ${err.message}", err)
      }

    response.use {
      if (!it.isSuccessful) {
        throw IOException("Voice terminal HTTP ${it.code}: ${it.message}")
      }
      val raw = it.body?.string().orEmpty()
      val root =
        try {
          json.parseToJsonElement(raw) as? JsonObject
        } catch (_: Throwable) {
          null
        } ?: throw IOException("Voice terminal invalid JSON response")

      val text = root["text"]?.jsonPrimitive?.content ?: ""
      val speak = root["speak"]?.jsonPrimitive?.booleanOrNull ?: false
      val ttsBase64 = root["tts_audio_base64"]?.jsonPrimitive?.contentOrNull
      val ttsBytes =
        ttsBase64?.takeIf { it.isNotBlank() }?.let {
          Base64.decode(it, Base64.DEFAULT)
        }
      return VoiceTerminalResponse(text = text, speak = speak, ttsAudioBytes = ttsBytes)
    }
  }

  private fun buildClient(): OkHttpClient {
    val builder = OkHttpClient.Builder()
    val tlsConfig =
      buildGatewayTlsConfig(tlsParams) { fingerprint ->
        onTlsFingerprint?.invoke(fingerprint)
      }
    if (tlsConfig != null) {
      builder.sslSocketFactory(tlsConfig.sslSocketFactory, tlsConfig.trustManager)
      builder.hostnameVerifier(tlsConfig.hostnameVerifier)
    }
    return builder.build()
  }

  private fun buildUrl(): String {
    val host = endpoint.host.trim().ifEmpty { throw IllegalStateException("gateway host missing") }
    val port = if (endpoint.gatewayPort != null && endpoint.gatewayPort > 0) endpoint.gatewayPort else endpoint.port
    val scheme = if (tlsParams != null) "https" else "http"
    val formattedHost = if (host.contains(":")) "[$host]" else host
    return "$scheme://$formattedHost:$port/webhooks/voice"
  }

  private companion object {
    val jsonMediaType = "application/json; charset=utf-8".toMediaType()
  }
}
