import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 1. Fetch all messages that haven't been grouped yet, in chronological order
    const { data: messages, error: fetchError } = await supabase
      .from('messages')
      .select('*')
      .is('listing_id', null)
      .order('sent_at', { ascending: true })

    if (fetchError) throw fetchError
    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ message: 'No pending messages to group.' }), { status: 200 })
    }

    const listingsToCreate: any[] = []
    let currentListing: any = null
    let orphanImages: any[] = []

    // 2. Group them together
    for (const msg of messages) {
      const hasText = msg.text || msg.caption

      if (hasText) {
        // Text or caption means a NEW listing starts
        currentListing = {
          text: msg.text || msg.caption,
          messages: [msg]
        }
        // If images arrived right before this text, attach them here
        if (orphanImages.length > 0) {
          currentListing.messages.unshift(...orphanImages)
          orphanImages = []
        }
        listingsToCreate.push(currentListing)
      } else if (msg.type === 'image') {
        // Captionless image
        if (currentListing) {
          // Attach to the current active listing
          currentListing.messages.push(msg)
        } else {
          // No active listing yet, hold it until a text message arrives
          orphanImages.push(msg)
        }
      }
    }

    // 3. Save to the database
    let createdCount = 0
    for (const listing of listingsToCreate) {
      // Insert into listings table
      const { data: insertedListing, error: insertError } = await supabase
        .from('listings')
        .insert({ text: listing.text })
        .select('id')
        .single()

      if (insertError) throw insertError

      // Update the raw messages to point to this new listing ID
      const messageIds = listing.messages.map((m: any) => m.id)
      const { error: updateError } = await supabase
        .from('messages')
        .update({ listing_id: insertedListing.id })
        .in('id', messageIds)

      if (updateError) throw updateError
      createdCount++
    }

    return new Response(
      JSON.stringify({ success: true, message: `Successfully grouped ${createdCount} listings.` }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})