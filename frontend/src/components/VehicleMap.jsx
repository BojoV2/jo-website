import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { apiRequest } from '../api.js';

// ── Marker icons ──────────────────────────────────────────────────
function makeMarkerIcon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 9.625 14 22 14 22S28 23.625 28 14C28 6.27 21.73 0 14 0z" fill="${color}" stroke="#fff" stroke-width="2"/>
    <circle cx="14" cy="14" r="5" fill="#fff" opacity="0.9"/>
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [28, 36], iconAnchor: [14, 36], popupAnchor: [0, -36] });
}
const ICON_MOVING  = makeMarkerIcon('#22c55e');
const ICON_IDLE    = makeMarkerIcon('#f59e0b');
const ICON_OFFLINE = makeMarkerIcon('#94a3b8');

function vehicleIcon(v) {
  if (!v.isOnline) return ICON_OFFLINE;
  if (v.isMoving)  return ICON_MOVING;
  return ICON_IDLE;
}
function statusDot(v) {
  if (!v.isOnline) return <span className="it-dot it-dot--offline" title="Offline" />;
  if (v.isMoving)  return <span className="it-dot it-dot--moving"  title="Moving"  />;
  return                  <span className="it-dot it-dot--idle"    title="Idle"    />;
}
function formatSpeed(kmh) {
  if (!kmh && kmh !== 0) return '—';
  return `${Math.round(kmh)} km/h`;
}
function formatTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function VehicleRow({ v, selected, onClick }) {
  return (
    <div
      className={`it-vehicle-item${selected ? ' it-vehicle-item--selected' : ''}`}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      <div className="it-vehicle-header">
        {statusDot(v)}
        <span className="it-vehicle-name">{v.name}</span>
        {v.plate && <span className="it-vehicle-plate">{v.plate}</span>}
      </div>
      <div className="it-vehicle-meta">
        <span>{v.speed > 0 ? formatSpeed(v.speed) : 'Stopped'}</span>
        {v.lastUpdate && <span>{formatTime(v.lastUpdate)}</span>}
      </div>
    </div>
  );
}

/**
 * VehicleMap — live fleet map powered by Leaflet + OpenStreetMap.
 * Props:
 *   token        {string}  JWT for API requests
 *   refreshMs    {number}  polling interval in ms (default 30 000)
 */
export default function VehicleMap({ token, refreshMs = 30_000 }) {
  const [trackerList, setTrackerList]   = useState([]);
  const [activeTrackerId, setActiveTrackerId] = useState(null);
  const [vehicles, setVehicles]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [syncing, setSyncing]           = useState(false);
  const [error, setError]               = useState('');
  const [syncError, setSyncError]       = useState('');
  const [syncedAt, setSyncedAt]         = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [search, setSearch]             = useState('');

  const mapRef     = useRef(null);
  const mapObj     = useRef(null);
  const markersRef = useRef({});

  // ── 1. Load tracker list ────────────────────────────────────────
  useEffect(() => {
    apiRequest('/tracking/status', { token })
      .then((data) => {
        setTrackerList(data);
        if (data.length > 0) setActiveTrackerId(data[0].id);
        else setLoading(false);
      })
      .catch((e) => { setError(e.message || 'Failed to load trackers'); setLoading(false); });
  }, [token]);

  // ── 2. Poll vehicles whenever tracker changes ───────────────────
  const loadVehicles = useCallback(async (id) => {
    if (!id) return;
    setSyncing(true);
    setSyncError('');
    try {
      const data = await apiRequest(`/tracking/${id}/vehicles`, { token });
      setVehicles(data.vehicles || []);
      setSyncedAt(data.synced_at || null);
      if (data.sync_error) setSyncError(data.sync_error);
    } catch (e) {
      setSyncError(e.message || 'Sync failed');
    } finally {
      setSyncing(false);
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!activeTrackerId) return;
    setLoading(true);
    loadVehicles(activeTrackerId);
    const interval = setInterval(() => loadVehicles(activeTrackerId), refreshMs);
    return () => clearInterval(interval);
  }, [activeTrackerId, loadVehicles, refreshMs]);

  // ── 3. Init Leaflet map ─────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return;
    const map = L.map(mapRef.current, {
      center: [14.5995, 120.9842],
      zoom: 11,
      zoomControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    mapObj.current = map;
    // Force Leaflet to recalculate tile layout after the tab/panel finishes rendering
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; }
    };
  }, []);

  // ── 4. Update markers when vehicles change ──────────────────────
  useEffect(() => {
    const map = mapObj.current;
    if (!map) return;

    const currentIds = new Set(vehicles.map((v) => v.id));
    const bounds = [];

    Object.entries(markersRef.current).forEach(([id, marker]) => {
      if (!currentIds.has(id)) { marker.remove(); delete markersRef.current[id]; }
    });

    vehicles.forEach((v) => {
      if (!v.lat || !v.lng) return;
      const latlng = [v.lat, v.lng];
      bounds.push(latlng);

      const popupHtml = () => `
        <div class="it-popup">
          <p class="it-popup-name">${v.name}</p>
          ${v.plate ? `<p><b>Plate:</b> ${v.plate}</p>` : ''}
          <p><b>Status:</b> ${v.isOnline ? (v.isMoving ? 'Moving' : 'Idle') : 'Offline'}</p>
          <p><b>Speed:</b> ${formatSpeed(v.speed)}</p>
          <p><b>Ignition:</b> ${v.ignition ? 'On' : 'Off'}</p>
          ${v.signal ? `<p><b>Signal:</b> ${v.signal}</p>` : ''}
          ${v.lastUpdate ? `<p><b>Updated:</b> ${formatTime(v.lastUpdate)}</p>` : ''}
        </div>`;

      if (markersRef.current[v.id]) {
        const m = markersRef.current[v.id];
        m.setLatLng(latlng);
        m.setIcon(vehicleIcon(v));
        m.getPopup()?.setContent(popupHtml());
      } else {
        const m = L.marker(latlng, { icon: vehicleIcon(v) })
          .bindPopup(popupHtml, { maxWidth: 240 })
          .addTo(map);
        m.on('click', () => setSelectedVehicle(v));
        markersRef.current[v.id] = m;
      }
    });

    if (bounds.length > 0 && !selectedVehicle) {
      try { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 }); } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles]);

  // ── 5. Pan to selected vehicle ──────────────────────────────────
  useEffect(() => {
    if (!selectedVehicle || !mapObj.current) return;
    const m = markersRef.current[selectedVehicle.id];
    if (m) { mapObj.current.setView(m.getLatLng(), 16, { animate: true }); m.openPopup(); }
  }, [selectedVehicle]);

  // ── Derived state ───────────────────────────────────────────────
  const counters = useMemo(() => ({
    all:     vehicles.length,
    online:  vehicles.filter((v) => v.isOnline).length,
    moving:  vehicles.filter((v) => v.isMoving).length,
    offline: vehicles.filter((v) => !v.isOnline).length,
  }), [vehicles]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return vehicles;
    return vehicles.filter((v) =>
      v.name.toLowerCase().includes(s) ||
      (v.plate && v.plate.toLowerCase().includes(s))
    );
  }, [vehicles, search]);

  // ── Render ──────────────────────────────────────────────────────
  if (error) return <p className="muted" style={{ color: 'var(--danger)' }}>{error}</p>;
  if (loading && trackerList.length === 0) return <p className="muted">Loading tracking system…</p>;
  if (!loading && trackerList.length === 0) return <p className="muted">No tracking portals are currently available.</p>;

  return (
    <div className="it-dashboard">

      {/* Top bar */}
      <div className="it-topbar">
        {trackerList.length > 1 ? (
          <select
            className="it-tracker-select"
            value={activeTrackerId || ''}
            onChange={(e) => { setActiveTrackerId(e.target.value); setSelectedVehicle(null); }}
          >
            {trackerList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        ) : (
          <span className="it-tracker-name">{trackerList[0]?.name}</span>
        )}

        <div className="it-counters">
          <div className="it-counter it-counter--all"><span className="it-counter-val">{counters.all}</span><span className="it-counter-lbl">All</span></div>
          <div className="it-counter it-counter--online"><span className="it-counter-val">{counters.online}</span><span className="it-counter-lbl">Online</span></div>
          <div className="it-counter it-counter--moving"><span className="it-counter-val">{counters.moving}</span><span className="it-counter-lbl">Moving</span></div>
          <div className="it-counter it-counter--offline"><span className="it-counter-val">{counters.offline}</span><span className="it-counter-lbl">Offline</span></div>
        </div>

        <div className="it-sync-info">
          {syncing && <span className="it-syncing">Syncing…</span>}
          {!syncing && syncedAt && <span className="it-synced-at">Updated {formatTime(syncedAt)}</span>}
          <button type="button" className="bt-copy-btn" disabled={syncing} onClick={() => loadVehicles(activeTrackerId)}>
            Refresh
          </button>
        </div>
      </div>

      {syncError && <div className="it-sync-error">Sync issue: {syncError}</div>}

      {/* Map + sidebar */}
      <div className="it-body">
        <div className="it-sidebar">
          <input
            type="search"
            className="it-search"
            placeholder="Search by name or plate…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="it-vehicle-list">
            {loading && vehicles.length === 0 && <p className="muted" style={{ padding: '12px 14px' }}>Loading vehicles…</p>}
            {!loading && filtered.length === 0 && <p className="muted" style={{ padding: '12px 14px' }}>No vehicles found.</p>}
            {filtered.map((v) => (
              <VehicleRow
                key={v.id}
                v={v}
                selected={selectedVehicle?.id === v.id}
                onClick={() => setSelectedVehicle(v.id === selectedVehicle?.id ? null : v)}
              />
            ))}
          </div>
        </div>
        <div className="it-map-area">
          <div ref={mapRef} className="it-map" />
        </div>
      </div>

      {/* Selected vehicle detail */}
      {selectedVehicle && (
        <div className="it-detail-panel">
          <div className="it-detail-header">
            <span className="it-detail-title">
              {statusDot(selectedVehicle)} {selectedVehicle.name}
              {selectedVehicle.plate && <span className="it-vehicle-plate">{selectedVehicle.plate}</span>}
            </span>
            <button type="button" className="it-detail-close" onClick={() => setSelectedVehicle(null)}>✕</button>
          </div>
          <div className="it-detail-grid">
            <div className="it-detail-field"><span>Status</span><strong>{selectedVehicle.isOnline ? (selectedVehicle.isMoving ? 'Moving' : 'Idle') : 'Offline'}</strong></div>
            <div className="it-detail-field"><span>Speed</span><strong>{formatSpeed(selectedVehicle.speed)}</strong></div>
            <div className="it-detail-field"><span>Ignition</span><strong>{selectedVehicle.ignition ? 'On' : 'Off'}</strong></div>
            {selectedVehicle.signal > 0 && <div className="it-detail-field"><span>Signal</span><strong>{selectedVehicle.signal}</strong></div>}
            {selectedVehicle.mileage > 0 && <div className="it-detail-field"><span>Mileage</span><strong>{selectedVehicle.mileage.toFixed(1)} km</strong></div>}
            <div className="it-detail-field"><span>Coordinates</span><strong>{selectedVehicle.lat.toFixed(6)}, {selectedVehicle.lng.toFixed(6)}</strong></div>
            {selectedVehicle.address && <div className="it-detail-field it-detail-field--wide"><span>Address</span><strong>{selectedVehicle.address}</strong></div>}
            <div className="it-detail-field it-detail-field--wide"><span>Last Update</span><strong>{formatTime(selectedVehicle.lastUpdate)}</strong></div>
          </div>
        </div>
      )}

      {/* Full table */}
      {vehicles.length > 0 && (
        <div className="it-table-wrap">
          <table className="it-table">
            <thead>
              <tr><th>Name</th><th>Plate</th><th>Status</th><th>Speed</th><th>Ignition</th><th>Signal</th><th>Lat</th><th>Lng</th><th>Last Update</th></tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr
                  key={v.id}
                  className={selectedVehicle?.id === v.id ? 'it-table-row--selected' : ''}
                  onClick={() => setSelectedVehicle(v.id === selectedVehicle?.id ? null : v)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{v.name}</td>
                  <td>{v.plate || '—'}</td>
                  <td>
                    <span className={`it-status-pill ${v.isOnline ? (v.isMoving ? 'it-status-pill--moving' : 'it-status-pill--idle') : 'it-status-pill--offline'}`}>
                      {v.isOnline ? (v.isMoving ? 'Moving' : 'Idle') : 'Offline'}
                    </span>
                  </td>
                  <td>{formatSpeed(v.speed)}</td>
                  <td>{v.ignition ? 'On' : 'Off'}</td>
                  <td>{v.signal || '—'}</td>
                  <td>{v.lat?.toFixed(5)}</td>
                  <td>{v.lng?.toFixed(5)}</td>
                  <td>{formatTime(v.lastUpdate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
