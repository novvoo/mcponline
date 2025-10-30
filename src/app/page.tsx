"use client";

import { useState, useRef, useEffect } from "react";

interface Header {
  id: string;
  key: string;
  value: string;
}

interface StreamEvent {
  id: string;
  time: string;
  raw: string;
  formatted?: any;
  type: 'connection' | 'data' | 'error' | 'info';
}

interface UserSettings {
  url: string;
  method: string;
  headers: Header[];
  body: string;
  formatJson: boolean;
  showTimestamps: boolean;
  autoScroll: boolean;
}

const STORAGE_KEY = 'mcp-online-settings';

const defaultSettings: UserSettings = {
  url: "https://",
  method: "POST",
  headers: [
    { id: "1", key: "Content-Type", value: "application/json" },
    { id: "2", key: "Accept", value: "text/event-stream" }
  ],
  body: `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}`,
  formatJson: true,
  showTimestamps: true,
  autoScroll: true
};

export default function Home() {
  const [url, setUrl] = useState(defaultSettings.url);
  const [method, setMethod] = useState(defaultSettings.method);
  const [headers, setHeaders] = useState<Header[]>(defaultSettings.headers);
  const [body, setBody] = useState(defaultSettings.body);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [formatJson, setFormatJson] = useState(defaultSettings.formatJson);
  const [showTimestamps, setShowTimestamps] = useState(defaultSettings.showTimestamps);
  const [autoScroll, setAutoScroll] = useState(defaultSettings.autoScroll);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [nextJsonRpcId, setNextJsonRpcId] = useState(1);

  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const bufferRef = useRef("");
  const eventsContainerRef = useRef<HTMLDivElement>(null);

  // Load settings from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const settings: UserSettings = JSON.parse(saved);
        setUrl(settings.url || defaultSettings.url);
        setMethod(settings.method || defaultSettings.method);
        setHeaders(settings.headers || defaultSettings.headers);
        setBody(settings.body || defaultSettings.body);
        setFormatJson(settings.formatJson ?? defaultSettings.formatJson);
        setShowTimestamps(settings.showTimestamps ?? defaultSettings.showTimestamps);
        setAutoScroll(settings.autoScroll ?? defaultSettings.autoScroll);
      }
    } catch (error) {
      console.warn('Failed to load settings from localStorage:', error);
    }
  }, []);

  // Save settings to localStorage whenever they change
  useEffect(() => {
    const settings: UserSettings = {
      url,
      method,
      headers,
      body,
      formatJson,
      showTimestamps,
      autoScroll
    };
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('Failed to save settings to localStorage:', error);
    }
  }, [url, method, headers, body, formatJson, showTimestamps, autoScroll]);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll && eventsContainerRef.current) {
      eventsContainerRef.current.scrollTop = eventsContainerRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  function addHeader() {
    const newId = Date.now().toString();
    setHeaders(prev => [...prev, { id: newId, key: "", value: "" }]);
  }

  function removeHeader(id: string) {
    setHeaders(prev => prev.filter(h => h.id !== id));
  }

  function updateHeader(id: string, field: 'key' | 'value', value: string) {
    setHeaders(prev => prev.map(h => h.id === id ? { ...h, [field]: value } : h));
  }

  function formatJsonContent(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  function detectEventType(raw: string): StreamEvent['type'] {
    if (raw.includes('Connected to') || raw.includes('Status:')) return 'connection';
    if (raw.includes('error') || raw.includes('Error') || raw.includes('aborted')) return 'error';
    if (raw.includes('Stream closed')) return 'info';
    return 'data';
  }

  function pushEvent(raw: string, type?: StreamEvent['type']) {
    const trimmedRaw = raw.trim();
    const eventType = type || detectEventType(trimmedRaw);
    
    const event: StreamEvent = {
      id: Date.now().toString() + Math.random(),
      time: new Date().toLocaleTimeString(),
      raw: trimmedRaw,
      formatted: formatJson ? formatJsonContent(trimmedRaw) : null,
      type: eventType
    };
    setEvents(prev => [...prev, event]);
  }

  function parseSSEChunk(chunk: string) {
    bufferRef.current += chunk;
    const lines = bufferRef.current.split('\n');
    bufferRef.current = lines.pop() || "";

    let eventData = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        eventData += line.substring(6) + "\n";
      } else if (line === "") {
        if (eventData.trim()) {
          pushEvent(eventData.trim());
          eventData = "";
        }
      }
    }
  }

  async function startStream() {
    if (running) return;
    
    setRunning(true);
    setEvents([]);
    bufferRef.current = "";

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const requestHeaders: Record<string, string> = {};
      headers.forEach(h => {
        if (h.key.trim() && h.value.trim()) {
          requestHeaders[h.key.trim()] = h.value.trim();
        }
      });

      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: method === "GET" ? undefined : body,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();

      pushEvent(`Connected to ${url}`, 'connection');
      pushEvent(`Status: ${response.status} ${response.statusText}`, 'connection');

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        parseSSEChunk(chunk);
      }

      // flush any remaining buffer
      if (bufferRef.current.trim()) {
        parseSSEChunk("\n\n");
      }
      
      pushEvent("Stream closed by server.", 'info');
    } catch (err: any) {
      if (err.name === "AbortError") {
        pushEvent("Stream aborted by user.", 'info');
      } else {
        pushEvent(`Stream error: ${err.message || String(err)}`, 'error');
      }
    } finally {
      setRunning(false);
      readerRef.current = null;
      controllerRef.current = null;
    }
  }

  function stopStream() {
    try {
      if (controllerRef.current) controllerRef.current.abort();
      if (readerRef.current) readerRef.current.cancel();
    } catch (e) {
      // ignore
    }
    setRunning(false);
  }

  function copyToClipboard(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function clearEvents() {
    setEvents([]);
  }

  // JSON-RPC templates
  const jsonRpcTemplates = {
    'tools/list': {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    },
    'tools/call': {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "example_tool",
        arguments: {}
      }
    },
    'resources/list': {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
      params: {}
    },
    'resources/read': {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: {
        uri: "file://example.txt"
      }
    },
    'prompts/list': {
      jsonrpc: "2.0",
      id: 5,
      method: "prompts/list",
      params: {}
    },
    'prompts/get': {
      jsonrpc: "2.0",
      id: 6,
      method: "prompts/get",
      params: {
        name: "example_prompt",
        arguments: {}
      }
    },
    'custom': {
      jsonrpc: "2.0",
      id: 7,
      method: "your_method",
      params: {}
    }
  };

  function validateJson(jsonString: string): { isValid: boolean; error?: string; formatted?: string } {
    try {
      const parsed = JSON.parse(jsonString);
      const formatted = JSON.stringify(parsed, null, 2);
      return { isValid: true, formatted };
    } catch (error) {
      return { 
        isValid: false, 
        error: error instanceof Error ? error.message : 'Invalid JSON' 
      };
    }
  }

  function formatJsonBody() {
    const validation = validateJson(body);
    if (validation.isValid && validation.formatted) {
      setBody(validation.formatted);
      setJsonError(null);
    } else {
      setJsonError(validation.error || 'Invalid JSON');
    }
  }

  function loadJsonRpcTemplate(templateKey: string) {
    const template = jsonRpcTemplates[templateKey as keyof typeof jsonRpcTemplates];
    if (template) {
      // Use the next available ID
      const templateWithId = { ...template, id: nextJsonRpcId };
      setBody(JSON.stringify(templateWithId, null, 2));
      setNextJsonRpcId(prev => prev + 1);
      setJsonError(null);
    }
  }

  function handleBodyChange(value: string) {
    setBody(value);
    // Clear error when user starts typing
    if (jsonError) {
      setJsonError(null);
    }
  }

  // Component for JSON syntax highlighting in textarea
  function JsonTextarea({ value, onChange, placeholder, rows }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    rows?: number;
  }) {
    const validation = validateJson(value);
    const lineCount = value.split('\n').length;
    
    return (
      <div className="relative">
        <div className="flex">
          {/* Line numbers */}
          <div 
            className="bg-gray-50 border-r border-gray-200 px-2 py-3 text-xs text-gray-500 font-mono select-none"
            style={{
              fontFamily: 'var(--font-geist-mono), Courier New, monospace',
              lineHeight: '1.5',
              minWidth: '3rem',
              textAlign: 'right'
            }}
          >
            {Array.from({ length: Math.max(lineCount, rows || 12) }, (_, i) => (
              <div key={i + 1}>{i + 1}</div>
            ))}
          </div>
          
          {/* Textarea */}
          <textarea 
            value={value} 
            onChange={e => onChange(e.target.value)} 
            rows={rows || 12} 
            className={`flex-1 px-4 py-3 border-0 focus:ring-2 focus:ring-gray-500 focus:outline-none bg-white text-gray-900 font-mono text-sm resize-none ${
              jsonError ? 'bg-red-50' : ''
            }`}
            placeholder={placeholder}
            style={{
              fontFamily: 'var(--font-geist-mono), Courier New, monospace',
              lineHeight: '1.5'
            }}
          />
        </div>
        
        {/* Border */}
        <div className={`absolute inset-0 border rounded-lg pointer-events-none ${
          jsonError ? 'border-red-300' : 'border-gray-300'
        }`}></div>
        
        {/* Status indicators */}
        {jsonError && (
          <div className="absolute top-2 right-2 bg-red-100 border border-red-300 rounded px-2 py-1 text-xs text-red-700 z-10">
            ⚠️ Invalid
          </div>
        )}
        {!jsonError && value && validation.isValid && (
          <div className="absolute top-2 right-2 bg-green-100 border border-green-300 rounded px-2 py-1 text-xs text-green-700 z-10">
            ✓ Valid JSON
          </div>
        )}
        
        {/* Character count */}
        <div className="absolute bottom-2 right-2 bg-gray-100 border border-gray-200 rounded px-2 py-1 text-xs text-gray-500 z-10">
          {value.length} chars
        </div>
      </div>
    );
  }

  function exportEvents() {
    const data = {
      timestamp: new Date().toISOString(),
      url,
      method,
      headers: headers.filter(h => h.key.trim() && h.value.trim()),
      body: method !== "GET" ? body : null,
      events: events.map(e => ({
        time: e.time,
        type: e.type,
        raw: e.raw,
        formatted: e.formatted
      }))
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url_obj = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url_obj;
    a.download = `mcp-stream-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url_obj);
  }

  // Component for rendering formatted JSON
  function JsonViewer({ data, level = 0 }: { data: any; level?: number }) {
    const indentStyle = { marginLeft: level > 0 ? '1rem' : '0' };
    
    if (data === null) return <span style={{ color: '#6b7280' }}>null</span>;
    if (data === undefined) return <span style={{ color: '#6b7280' }}>undefined</span>;
    if (typeof data === 'string') return <span style={{ color: '#34d399' }}>"{data}"</span>;
    if (typeof data === 'number') return <span style={{ color: '#60a5fa' }}>{data}</span>;
    if (typeof data === 'boolean') return <span style={{ color: '#a78bfa' }}>{String(data)}</span>;
    
    if (Array.isArray(data)) {
      if (data.length === 0) return <span style={{ color: '#9ca3af' }}>[]</span>;
      return (
        <div style={indentStyle}>
          <span style={{ color: '#9ca3af' }}>[</span>
          {data.map((item, index) => (
            <div key={index} style={{ marginLeft: '1rem' }}>
              <JsonViewer data={item} level={level + 1} />
              {index < data.length - 1 && <span style={{ color: '#9ca3af' }}>,</span>}
            </div>
          ))}
          <span style={{ color: '#9ca3af' }}>]</span>
        </div>
      );
    }
    
    if (typeof data === 'object') {
      const keys = Object.keys(data);
      if (keys.length === 0) return <span style={{ color: '#9ca3af' }}>{"{}"}</span>;
      
      return (
        <div style={indentStyle}>
          <span style={{ color: '#9ca3af' }}>{"{"}</span>
          {keys.map((key, index) => (
            <div key={key} style={{ marginLeft: '1rem' }}>
              <span style={{ color: '#fbbf24' }}>"{key}"</span>
              <span style={{ color: '#9ca3af' }}>: </span>
              <JsonViewer data={data[key]} level={level + 1} />
              {index < keys.length - 1 && <span style={{ color: '#9ca3af' }}>,</span>}
            </div>
          ))}
          <span style={{ color: '#9ca3af' }}>{"}"}</span>
        </div>
      );
    }
    
    return <span style={{ color: '#d1d5db' }}>{String(data)}</span>;
  }

  // Component for rendering individual events
  function EventItem({ event }: { event: StreamEvent }) {
    const getEventIcon = () => {
      const iconStyle = {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        display: 'inline-block'
      };
      
      switch (event.type) {
        case 'connection': return <span style={{ ...iconStyle, backgroundColor: '#3b82f6' }}></span>;
        case 'error': return <span style={{ ...iconStyle, backgroundColor: '#ef4444' }}></span>;
        case 'info': return <span style={{ ...iconStyle, backgroundColor: '#f59e0b' }}></span>;
        default: return <span style={{ ...iconStyle, backgroundColor: '#10b981' }}></span>;
      }
    };

    const eventItemStyle = {
      marginBottom: '1rem',
      paddingBottom: '0.75rem',
      borderBottom: '1px solid #374151'
    };

    const timestampStyle = {
      fontSize: '0.75rem',
      color: '#6b7280',
      marginBottom: '0.5rem',
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem'
    };

    const jsonFormattedStyle = {
      backgroundColor: '#111827',
      border: '1px solid #374151',
      borderRadius: '0.5rem',
      padding: '0.75rem'
    };

    const copyButtonStyle = {
      backgroundColor: 'rgba(55, 65, 81, 0.8)',
      color: '#9ca3af',
      border: 'none',
      borderRadius: '0.25rem',
      padding: '0.25rem 0.5rem',
      fontSize: '0.75rem',
      cursor: 'pointer',
      transition: 'all 0.2s ease'
    };

    return (
      <div style={eventItemStyle}>
        {showTimestamps && (
          <div style={timestampStyle}>
            {getEventIcon()}
            <span>{event.time}</span>
            <span style={{ color: '#6b7280', textTransform: 'capitalize' }}>({event.type})</span>
          </div>
        )}
        
        {event.formatted && formatJson ? (
          <div style={jsonFormattedStyle}>
            <div style={{ 
              ...timestampStyle, 
              marginBottom: '0.5rem', 
              justifyContent: 'space-between',
              display: 'flex'
            }}>
              <span>Formatted JSON</span>
              <button 
                onClick={() => copyToClipboard(JSON.stringify(event.formatted, null, 2))}
                style={copyButtonStyle}
                title="Copy formatted JSON"
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(55, 65, 81, 1)';
                  e.currentTarget.style.color = '#d1d5db';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(55, 65, 81, 0.8)';
                  e.currentTarget.style.color = '#9ca3af';
                }}
              >
                📋 Copy
              </button>
            </div>
            <JsonViewer data={event.formatted} />
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <pre style={{ 
              backgroundColor: '#111827', 
              border: '1px solid #374151',
              borderRadius: '0.5rem',
              padding: '0.75rem',
              color: '#d1d5db',
              lineHeight: '1.6',
              whiteSpace: 'pre-wrap',
              fontFamily: 'var(--font-geist-mono), Courier New, monospace',
              margin: 0
            }}>
              {event.raw}
            </pre>
            <button 
              onClick={() => copyToClipboard(event.raw)}
              style={{ 
                ...copyButtonStyle,
                position: 'absolute', 
                top: '0.5rem', 
                right: '0.5rem',
                opacity: 0.7
              }}
              title="Copy raw content"
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1';
                e.currentTarget.style.backgroundColor = 'rgba(55, 65, 81, 1)';
                e.currentTarget.style.color = '#d1d5db';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.7';
                e.currentTarget.style.backgroundColor = 'rgba(55, 65, 81, 0.8)';
                e.currentTarget.style.color = '#9ca3af';
              }}
            >
              📋
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf9f7]">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">MCP Online</h1>
              <p className="text-sm text-gray-600 mt-1">Server-Sent Events Stream Tester</p>
            </div>
            <div className="flex items-center gap-3">
              <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                running 
                  ? 'bg-green-100 text-green-800 border border-green-200' 
                  : 'bg-gray-100 text-gray-600 border border-gray-200'
              }`}>
                {running ? '● Connected' : '○ Disconnected'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Panel - Request Configuration */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Request Configuration</h2>
            </div>
            
            <div className="p-6 space-y-6">
              {/* URL and Method */}
              <div className="space-y-3">
                <label className="block text-sm font-medium text-gray-700">Endpoint</label>
                <div className="flex gap-3">
                  <input 
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-500 focus:border-transparent bg-white text-gray-900 placeholder-gray-500" 
                    value={url} 
                    onChange={e => setUrl(e.target.value)} 
                    placeholder="https://your-mcp-endpoint.com/stream" 
                  />
                  <select 
                    value={method} 
                    onChange={e => setMethod(e.target.value)} 
                    className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-500 focus:border-transparent bg-white text-gray-900"
                  >
                    <option>POST</option>
                    <option>GET</option>
                  </select>
                  <button 
                    className={`px-6 py-2 rounded-lg font-medium transition-colors ${
                      running 
                        ? 'bg-red-600 hover:bg-red-700 text-white' 
                        : 'bg-gray-900 hover:bg-gray-800 text-white'
                    }`} 
                    onClick={() => (running ? stopStream() : startStream())}
                  >
                    {running ? 'Stop' : 'Connect'}
                  </button>
                </div>
              </div>

              {/* Headers */}
              <div className="space-y-3">
                <label className="block text-sm font-medium text-gray-700">Headers</label>
                <div className="space-y-2">
                  {headers.map(h => (
                    <div key={h.id} className="flex gap-2">
                      <input 
                        value={h.key} 
                        onChange={e => updateHeader(h.id, 'key', e.target.value)} 
                        placeholder="Header name" 
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-500 focus:border-transparent bg-white text-gray-900 placeholder-gray-500 text-sm" 
                      />
                      <input 
                        value={h.value} 
                        onChange={e => updateHeader(h.id, 'value', e.target.value)} 
                        placeholder="Header value" 
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-500 focus:border-transparent bg-white text-gray-900 placeholder-gray-500 text-sm" 
                      />
                      <button 
                        onClick={() => removeHeader(h.id)} 
                        className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600 hover:text-gray-800 transition-colors"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button 
                    onClick={addHeader} 
                    className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
                  >
                    + Add Header
                  </button>
                </div>
              </div>

              {/* JSON-RPC Templates */}
              <div className="space-y-3">
                <label className="block text-sm font-medium text-gray-700">JSON-RPC Templates</label>
                <div className="grid grid-cols-2 gap-2">
                  {Object.keys(jsonRpcTemplates).map(templateKey => (
                    <button
                      key={templateKey}
                      onClick={() => loadJsonRpcTemplate(templateKey)}
                      className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-xs font-medium text-left"
                      title={`Load ${templateKey} template`}
                    >
                      {templateKey === 'custom' ? '🔧 Custom' : `📋 ${templateKey}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Request Body */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">Request Body</label>
                  <div className="flex gap-2">
                    <button 
                      onClick={formatJsonBody}
                      className="px-2 py-1 border border-gray-300 rounded text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-50 transition-colors"
                      title="Format and validate JSON"
                    >
                      ✨ Format
                    </button>
                  </div>
                </div>
                <JsonTextarea
                  value={body}
                  onChange={handleBodyChange}
                  placeholder="Enter your JSON-RPC request body here..."
                  rows={12}
                />
                <div className="flex gap-2 flex-wrap">
                  <button 
                    onClick={() => copyToClipboard(body)} 
                    className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
                  >
                    📋 Copy Body
                  </button>
                  <button 
                    onClick={() => { setBody(''); setJsonError(null); }} 
                    className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
                  >
                    🗑️ Clear Body
                  </button>
                  <button 
                    onClick={() => {
                      const validation = validateJson(body);
                      if (validation.isValid) {
                        alert('✅ JSON is valid!');
                        setJsonError(null);
                      } else {
                        setJsonError(validation.error || 'Invalid JSON');
                      }
                    }}
                    className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
                  >
                    ✓ Validate
                  </button>
                  <button 
                    onClick={() => {
                      try {
                        const parsed = JSON.parse(body);
                        const minified = JSON.stringify(parsed);
                        setBody(minified);
                        setJsonError(null);
                      } catch (error) {
                        setJsonError(error instanceof Error ? error.message : 'Invalid JSON');
                      }
                    }}
                    className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
                  >
                    📦 Minify
                  </button>
                </div>
                {jsonError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-red-500">⚠️</span>
                      <span className="text-sm text-red-700 font-medium">JSON Error:</span>
                    </div>
                    <p className="text-sm text-red-600 mt-1 font-mono">{jsonError}</p>
                  </div>
                )}
              </div>

              {/* Display Settings */}
              <div className="space-y-3">
                <label className="block text-sm font-medium text-gray-700">Display Settings</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      checked={formatJson} 
                      onChange={e => setFormatJson(e.target.checked)}
                      className="rounded border-gray-300 text-gray-600 focus:ring-gray-500"
                    />
                    <span className="text-sm text-gray-700">Format JSON responses</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      checked={showTimestamps} 
                      onChange={e => setShowTimestamps(e.target.checked)}
                      className="rounded border-gray-300 text-gray-600 focus:ring-gray-500"
                    />
                    <span className="text-sm text-gray-700">Show timestamps</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      checked={autoScroll} 
                      onChange={e => setAutoScroll(e.target.checked)}
                      className="rounded border-gray-300 text-gray-600 focus:ring-gray-500"
                    />
                    <span className="text-sm text-gray-700">Auto-scroll to new events</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          {/* Right Panel - Response Stream */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Response Stream</h2>
                  <p className="text-xs text-gray-600 mt-1">
                    {events.length} events • {events.filter(e => e.type === 'data').length} data • {events.filter(e => e.type === 'error').length} errors
                  </p>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={exportEvents} 
                    className="px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
                    title="Export events as JSON"
                  >
                    Export
                  </button>
                  <button 
                    onClick={clearEvents} 
                    className="px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
                  >
                    Clear
                  </button>
                  <button 
                    onClick={() => copyToClipboard(events.map(e => e.raw).join('\n\n'))} 
                    className="px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
                  >
                    Copy All
                  </button>
                </div>
              </div>
            </div>

            <div 
              ref={eventsContainerRef}
              style={{
                height: '600px',
                overflowY: 'auto',
                backgroundColor: '#1a1a1a',
                color: '#a0aec0',
                padding: '1rem',
                fontSize: '0.875rem',
                fontFamily: 'var(--font-geist-mono), Courier New, monospace'
              }}
            >
              {events.length === 0 && (
                <div style={{
                  opacity: 0.6,
                  textAlign: 'center',
                  padding: '3rem 0',
                  color: '#6b7280'
                }}>
                  <div style={{ color: '#6b7280', marginBottom: '0.5rem' }}>No events yet</div>
                  <div style={{ fontSize: '0.75rem', color: '#4b5563' }}>
                    Click "Connect" to start streaming. SSE data events will appear here in real-time.
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#4b5563', marginTop: '1rem' }}>
                    💡 Enable "Format JSON responses" in settings for better readability
                  </div>
                </div>
              )}
              {events.map(ev => (
                <EventItem key={ev.id} event={ev} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}