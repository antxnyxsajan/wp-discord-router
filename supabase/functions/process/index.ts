import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

interface ClassificationResult {
  category: "automobile" | "real_estate" | "machinery" | "other"
  fields: {
    title: string
    price: string
    location: string
    details: string
  }
  confidence: number
}

// -------------------------------------------------------------
// classify(): Cohere wrapper for listing text classification
// -------------------------------------------------------------
async function classify(text: string): Promise<ClassificationResult> {
  const apiKey = Deno.env.get('COHERE_API_KEY')
  if (!apiKey) {
    throw new Error('COHERE_API_KEY environment variable is missing')
  }

  const systemPrompt = `You are a sale listing classifier. Analyze the provided listing text and extract structured information.
Respond with ONLY valid JSON matching this schema:
{
  "category": "automobile" | "real_estate" | "machinery" | "other",
  "fields": {
    "title": "short descriptive title",
    "price": "extracted price or N/A",
    "location": "extracted location or N/A",
    "details": "key specifications or summary"
  },
  "confidence": <float between 0.0 and 1.0>
}`

  const response = await fetch('https://api.cohere.com/v2/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'command-r-08-2024',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Cohere API error (${response.status}): ${errText}`)
  }

  const data = await response.json()
  const rawContent = data.message?.content?.[0]?.text
  if (!rawContent) {
    throw new Error('Cohere returned an empty response')
  }

  return JSON.parse(rawContent) as ClassificationResult
}

serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // =========================================================
    // STEP 1: GROUPING
    // =========================================================
    const { data: messages, error: fetchError } = await supabase
      .from('messages')
      .select('*')
      .is('listing_id', null)
      .order('sent_at', { ascending: true })

    if (fetchError) throw fetchError

    const listingsToCreate: any[] = []
    let currentListing: any = null
    let orphanImages: any[] = []

    if (messages && messages.length > 0) {
      for (const msg of messages) {
        const hasText = msg.text || msg.caption

        if (hasText) {
          currentListing = {
            text: msg.text || msg.caption,
            messages: [msg]
          }
          if (orphanImages.length > 0) {
            currentListing.messages.unshift(...orphanImages)
            orphanImages = []
          }
          listingsToCreate.push(currentListing)
        } else if (msg.type === 'image') {
          if (currentListing) {
            currentListing.messages.push(msg)
          } else {
            orphanImages.push(msg)
          }
        }
      }

      for (const listing of listingsToCreate) {
        const { data: insertedListing, error: insertError } = await supabase
          .from('listings')
          .insert({ text: listing.text, status: 'pending' })
          .select('id')
          .single()

        if (insertError) throw insertError

        const messageIds = listing.messages.map((m: any) => m.id)
        const { error: updateError } = await supabase
          .from('messages')
          .update({ listing_id: insertedListing.id })
          .in('id', messageIds)

        if (updateError) throw updateError
      }
    }

    // =========================================================
    // STEP 2: CLASSIFICATION (Cohere)
    // =========================================================
    const { data: pendingListings, error: pendingError } = await supabase
      .from('listings')
      .select('*')
      .eq('status', 'pending')

    if (pendingError) throw pendingError

    let classifiedCount = 0
    if (pendingListings && pendingListings.length > 0) {
      for (const listing of pendingListings) {
        try {
          if (!listing.text || listing.text.trim().length === 0) {
            // Listings with no text route straight to unsorted
            await supabase
              .from('listings')
              .update({
                category: 'other',
                channel: 'unsorted',
                confidence: 0,
                status: 'classified'
              })
              .eq('id', listing.id)
            classifiedCount++
            continue
          }

          const result = await classify(listing.text)

          // Routing logic: confidence < 0.6 routes to unsorted
          const channel = (result.confidence && result.confidence >= 0.6)
            ? result.category
            : 'unsorted'

          await supabase
            .from('listings')
            .update({
              category: result.category,
              fields: result.fields,
              confidence: result.confidence,
              channel: channel,
              status: 'classified'
            })
            .eq('id', listing.id)

          classifiedCount++
        } catch (err: any) {
          await supabase
            .from('listings')
            .update({
              status: 'failed',
              error: `Classification failed: ${err.message}`
            })
            .eq('id', listing.id)
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        grouped: listingsToCreate.length,
        classified: classifiedCount
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})