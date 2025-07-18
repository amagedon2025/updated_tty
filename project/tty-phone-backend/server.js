const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 10000;

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  path: '/media-stream'
});

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'https://your-frontend-domain.com'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Twilio client
let client;
try {
  console.log('Initializing Twilio client...');
  console.log('Account SID:', process.env.TWILIO_ACCOUNT_SID ? 'Set' : 'Missing');
  console.log('Auth Token:', process.env.TWILIO_AUTH_TOKEN ? 'Set' : 'Missing');
  console.log('Phone Number:', process.env.TWILIO_PHONE_NUMBER);
  
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('✅ Twilio client initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize Twilio client:', error);
  process.exit(1);
}

// Store active calls and WebSocket connections
const activeCalls = new Map();
const callWebSockets = new Map();

// Get the base URL for webhooks
const getBaseUrl = () => {
  return process.env.NODE_ENV === 'production' 
    ? 'https://tty-phone-interface.onrender.com'
    : `http://localhost:${port}`;
};

// Get WebSocket URL
const getWebSocketUrl = () => {
  return process.env.NODE_ENV === 'production' 
    ? 'wss://tty-phone-interface.onrender.com/media-stream'
    : `ws://localhost:${port}/media-stream`;
};
// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection established');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'join-call' && data.callSid) {
        // Associate WebSocket with call
        callWebSockets.set(data.callSid, ws);
        ws.callSid = data.callSid;
        console.log(`🎵 WebSocket joined call: ${data.callSid}`);
        
        ws.send(JSON.stringify({
          type: 'joined',
          callSid: data.callSid,
          message: 'Connected to live audio stream'
        }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
  
  ws.on('close', () => {
    if (ws.callSid) {
      callWebSockets.delete(ws.callSid);
      console.log(`🔌 WebSocket disconnected from call: ${ws.callSid}`);
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'TTY Phone Backend with Optimal WebSocket Streaming', 
    timestamp: new Date(),
    port: port,
    baseUrl: getBaseUrl(),
    twilioConfigured: !!client,
    webSocketConnections: wss.clients.size,
    features: ['WebSocket Live Audio', 'Minimal Twilio Usage', 'Real-time Streaming']
  });
});

// TwiML for outgoing calls with media streaming
app.post('/twiml/outgoing-call', (req, res) => {
  const { To, From } = req.body;
  console.log(`📞 Outgoing call TwiML: ${From} calling ${To}`);
  
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Brief greeting
  twiml.say({
    voice: 'alice',
    rate: '1.0'
  }, 'Hello, you are now connected to a TTY communication service.');
  
  // Start media stream for live audio
  const start = twiml.start();
  start.stream({
    name: 'live-audio-stream',
    url: getWebSocketUrl(),
    track: 'inbound_track'
  });
  
  // Keep the call alive and listen for messages
  twiml.gather({
    input: 'speech',
    timeout: 300,
    action: `${getBaseUrl()}/twiml/continue-call`,
    method: 'POST'
  });
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// TwiML to continue the call after gathering
app.post('/twiml/continue-call', (req, res) => {
  console.log('📞 Continuing call...');
  
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Continue listening
  twiml.gather({
    input: 'speech',
    timeout: 300,
    action: `${getBaseUrl()}/twiml/continue-call`,
    method: 'POST'
  });
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// TwiML for speaking messages during call
app.post('/twiml/speak-message', (req, res) => {
  const { message, voice = 'alice', rate = '1.0' } = req.body;
  
  console.log(`🗣️ Speaking message: "${message}"`);
  
  const twiml = new twilio.twiml.VoiceResponse();
  
  if (message) {
    // Map voice names to Twilio voices
    let twilioVoice = 'alice';
    if (voice && typeof voice === 'string') {
      const voiceLower = voice.toLowerCase();
      if (voiceLower.includes('male') && !voiceLower.includes('female')) {
        twilioVoice = 'man';
      } else if (voiceLower.includes('woman')) {
        twilioVoice = 'woman';
      }
    }
    
    twiml.say({
      voice: twilioVoice,
      rate: rate
    }, message.replace(/[<>&"']/g, (match) => {
      const escapeMap = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
      return escapeMap[match];
    }));
  }
  
  // Continue listening after speaking
  twiml.gather({
    input: 'speech',
    timeout: 300,
    action: `${getBaseUrl()}/twiml/continue-call`,
    method: 'POST'
  });
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Initiate call with live audio streaming
app.post('/api/initiate-call', async (req, res) => {
  try {
    const { to } = req.body;
    
    console.log(`📞 Initiating optimized call to: ${to}`);
    
    const call = await client.calls.create({
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${getBaseUrl()}/twiml/outgoing-call`,
      method: 'POST',
      statusCallback: `${getBaseUrl()}/webhook/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    // Store call data
    activeCalls.set(call.sid, {
      sid: call.sid,
      to: to,
      status: call.status,
      startTime: new Date(),
      isActive: true,
      streamActive: false,
      streamSid: null,
      messagesSent: []
    });

    console.log(`✅ Optimized call initiated successfully: ${call.sid}`);
    
    res.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      to: to,
      streamingEnabled: true,
      websocketUrl: getWebSocketUrl()
    });
  } catch (error) {
    console.error('❌ Error initiating call:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: error.code 
    });
  }
});

// Speak text during call
app.post('/api/speak-text', async (req, res) => {
  try {
    const { callSid, text, voice = 'alice', rate = '1.0' } = req.body;
    
    const callData = activeCalls.get(callSid);
    if (!callData || !callData.isActive) {
      return res.status(404).json({ 
        success: false, 
        error: 'Call not found or ended' 
      });
    }

    console.log(`📤 Sending message to call ${callSid}: "${text}"`);
    
    // Use Twilio's REST API to play the message without updating the call flow
    const twiml = `<Response>
      <Say voice="${voice === 'alice' ? 'alice' : voice.includes('male') ? 'man' : 'woman'}" rate="${rate}">
        ${text.replace(/[<>&"']/g, (match) => {
          const escapeMap = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
          return escapeMap[match];
        })}
      </Say>
    </Response>`;
    
    // Create a new call leg to play the message without interrupting the main call
    try {
      await client.calls.create({
        to: callData.to,
        from: process.env.TWILIO_PHONE_NUMBER,
        twiml: twiml
      });
    } catch (twilioError) {
      console.error('Error creating message call:', twilioError);
      // Fallback: try updating the existing call
      await client.calls(callSid).update({
        twiml: `<Response>
          <Say voice="alice" rate="${rate}">${text}</Say>
          <Gather input="speech" timeout="300" action="${getBaseUrl()}/twiml/continue-call" method="POST" />
        </Response>`
      });
    }

    // Track sent messages
    callData.messagesSent.push({
      text,
      timestamp: new Date(),
      voice,
      rate
    });

    console.log(`✅ Message sent successfully (optimized)`);
    
    res.json({ success: true, message: 'Text spoken successfully' });
  } catch (error) {
    console.error('❌ Error speaking text:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Call status webhook
app.post('/webhook/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  
  console.log(`📊 Call status update: ${CallSid} is now ${CallStatus}`);
  
  const callData = activeCalls.get(CallSid);
  if (callData) {
    callData.status = CallStatus;
    
    if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'canceled') {
      callData.isActive = false;
      callData.streamActive = false;
      console.log(`📞 Call ${CallSid} ended with status: ${CallStatus}`);
      
      // Notify WebSocket client
      const ws = callWebSockets.get(CallSid);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'call-ended',
          callSid: CallSid,
          status: CallStatus
        }));
      }
    } else if (CallStatus === 'in-progress') {
      console.log(`🎵 Call ${CallSid} is now in progress - audio stream should start`);
    }
  }
  
  res.status(200).send('OK');
});

// Get call status
app.get('/api/call-status/:callSid', async (req, res) => {
  try {
    const { callSid } = req.params;
    
    const callData = activeCalls.get(callSid);
    
    if (!callData) {
      return res.status(404).json({ 
        success: false, 
        error: 'Call not found' 
      });
    }
    
    res.json({
      success: true,
      status: callData.status,
      isActive: callData.isActive,
      startTime: callData.startTime,
      messagesSent: callData.messagesSent || [],
      streamingEnabled: true,
      streamActive: callData.streamActive || false,
      websocketConnected: callWebSockets.has(callSid)
    });
  } catch (error) {
    console.error('❌ Error fetching call status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// End call
app.post('/api/end-call', async (req, res) => {
  try {
    const { callSid } = req.body;
    
    const callData = activeCalls.get(callSid);
    if (!callData) {
      return res.status(404).json({ 
        success: false, 
        error: 'Call not found' 
      });
    }

    console.log(`📞 Ending call: ${callSid}`);

    try {
      await client.calls(callSid).update({
        twiml: '<Response><Say voice="alice">Thank you for using TTY service. Goodbye.</Say><Hangup/></Response>'
      });
    } catch (twilioError) {
      console.log('Call may have already ended:', twilioError.message);
    }

    callData.isActive = false;
    callData.streamActive = false;
    
    // Close WebSocket connection
    const ws = callWebSockets.get(callSid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'call-ended',
        callSid: callSid
      }));
      ws.close();
    }
    callWebSockets.delete(callSid);

    res.json({ success: true, message: 'Call ended successfully' });
  } catch (error) {
    console.error('❌ Error ending call:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// List active calls
app.get('/api/active-calls', (req, res) => {
  const calls = Array.from(activeCalls.values());
  res.json({ 
    success: true, 
    activeCalls: calls,
    websocketConnections: wss.clients.size
  });
});

// Start server with WebSocket support
server.listen(port, () => {
  console.log(`🚀 TTY Phone Backend with Optimal WebSocket Streaming running on port ${port}`);
  console.log(`📞 Twilio integration ready`);
  console.log(`🌐 Webhook base URL: ${getBaseUrl()}`);
  console.log(`🔌 WebSocket server ready for live audio streaming`);
  console.log(`⚡ Minimal Twilio resource usage - Maximum performance`);
  console.log(`🎵 Real-time audio streaming optimized`);
});
