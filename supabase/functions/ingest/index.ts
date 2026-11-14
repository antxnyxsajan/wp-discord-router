import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { decode } from "https://deno.land/std@0.168.0/encoding/base64.ts"

serve(async (req) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const payload = await req.json()
    const { id, type, text, caption, media, sent_at } = payload

    // Initialize Supabase client with the Service Role key to bypass RLS
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    let media_path = null

    // If there is media (assuming base64 string for this stand-in), upload it to Storage
    if (media) {
      const fileName = `${id}-${Date.now()}.jpg` // Simplified for the stand-in
      const fileBuffer = decode(media)

      const { data: uploadData, error: uploadError } = await supabaseClient
        .storage
        .from('media')
        .upload(fileName, fileBuffer, {
          contentType: 'image/jpeg',
          upsert: false
        })

      if (uploadError) {
        throw new Error(`Media upload failed: ${uploadError.message}`)
      }
      media_path = uploadData.path
    }

    // Insert the normalized payload into the messages table
    const { error: dbError } = await supabaseClient
      .from('messages')
      .insert({
        wa_message_id: id, // Dedupe key placeholder
        type: type,
        text: text || null,
        caption: caption || null,
        media_path: media_path,
        sent_at: sent_at
      })

    if (dbError) {
      throw new Error(`Database insert failed: ${dbError.message}`)
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Ingested successfully' }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})