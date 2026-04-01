import re

def update_main_js():
    file_path = "extension/webview/main.js"
    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()

    new_svgs = """
  var BUDDY_CAMERA = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<rect x="35" y="45" width="45" height="30" rx="4" fill="#2d3436"/>' +
    '<circle cx="57" cy="60" r="10" fill="#636e72" stroke="#b2bec3" stroke-width="2"/>' +
    '<circle cx="57" cy="60" r="4" fill="#2d3436"/>' +
    '<ellipse cx="43" cy="50" rx="4" ry="2" fill="#fff" opacity="0.6"/>' +
    '<path d="M 35 70 L 45 90 M 70 70 L 60 90" stroke="#7B8EC8" stroke-width="5" stroke-linecap="round"/>' +
    '<path d="M 25 35 L 35 25 L 45 40 L 40 50 Z" fill="#ffeaa7"/>' +
    '<path d="M 15 20 L 30 25 M 35 10 L 35 20 M 45 15 L 40 25" stroke="#ffeaa7" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  var BUDDY_DEAD = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.3"/>' +
    '<g transform="translate(0, 50) scale(1, 0.4)">' +
    '<path d="M 25 100 C 15 100, 15 90, 25 85 C 40 85, 45 95, 35 100 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 100 C 85 100, 85 90, 75 85 C 60 85, 55 95, 65 100 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="75" rx="40" ry="28" fill="#fff"/>' +
    '<circle cx="30" cy="40" r="14" fill="#7B8EC8" transform="scale(1, 1.5)"/><circle cx="70" cy="40" r="14" fill="#7B8EC8" transform="scale(1, 1.5)"/>' +
    '<path d="M 10 55 C 10 25, 90 25, 90 55 C 90 80, 70 85, 50 85 C 30 85, 10 80, 10 55 Z" fill="#fff"/>' +
    '<path d="M 25 45 C 15 60, 25 70, 38 65 C 48 61, 45 40, 35 37 C 30 35, 28 35, 25 45 Z" fill="#7B8EC8" transform="rotate(-20 32 51)"/>' +
    '<path d="M 75 45 C 85 60, 75 70, 62 65 C 52 61, 55 40, 65 37 C 70 35, 72 35, 75 45 Z" fill="#7B8EC8" transform="rotate(20 68 51)"/>' +
    '<path d="M 32 55 L 42 65 M 32 65 L 42 55" stroke="#3B4A7A" stroke-width="2.5" stroke-linecap="round"/>' +
    '<path d="M 58 55 L 68 65 M 58 65 L 68 55" stroke="#3B4A7A" stroke-width="2.5" stroke-linecap="round"/>' +
    '<path d="M 45 70 Q 50 67, 55 70" stroke="#3B4A7A" stroke-width="2" fill="none" stroke-linecap="round"/>' +
    '</g>' +
    '<g opacity="0.6" transform="translate(40, -10)">' +
    '<path d="M 10 50 Q 0 40, 10 25 Q 20 10, 10 0" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/>' +
    '<path d="M 10 0 L 5 5 M 10 0 L 15 5" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' +
    '</g>' +
    '</svg>';

  var BUDDY_SHOCKED = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 15 45 C 10 25, -5 20, 10 10 C 20 5, 30 30, 25 45 Z" fill="#7B8EC8"/>' +
    '<path d="M 85 45 C 90 25, 105 20, 90 10 C 80 5, 70 30, 75 45 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8" transform="translate(0,-5)"/><circle cx="80" cy="30" r="14" fill="#7B8EC8" transform="translate(0,-5)"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<circle cx="34" cy="46" r="4.5" fill="#3B4A7A"/><circle cx="66" cy="46" r="4.5" fill="#3B4A7A"/>' +
    '<circle cx="34" cy="46" r="1.5" fill="#fff"/><circle cx="66" cy="46" r="1.5" fill="#fff"/>' +
    '<ellipse cx="50" cy="66" rx="4" ry="7" fill="#3B4A7A"/>' +
    '<path d="M 28 35 Q 34 30, 40 38" stroke="#3B4A7A" stroke-width="2" fill="none" stroke-linecap="round"/>' +
    '<path d="M 72 35 Q 66 30, 60 38" stroke="#3B4A7A" stroke-width="2" fill="none" stroke-linecap="round"/>' +
    '</svg>';\n"""

    text = text.replace("var svgs = {\n      idle: BUDDY_IDLE, thinking: BUDDY_THINKING,\n      working: BUDDY_WORKING, happy: BUDDY_HAPPY,\n      sad: BUDDY_SAD, sleeping: BUDDY_SLEEPING\n    };", 
                        "var svgs = {\n      idle: BUDDY_IDLE, thinking: BUDDY_THINKING,\n      working: BUDDY_WORKING, happy: BUDDY_HAPPY,\n      sad: BUDDY_SAD, sleeping: BUDDY_SLEEPING,\n      camera: BUDDY_CAMERA, dead: BUDDY_DEAD, shocked: BUDDY_SHOCKED\n    };")

    part1 = "var BUDDY_SLEEPING ="
    part2 = "</svg>';"
    idx = text.find(part1)
    if idx != -1:
        end_idx = text.find(part2, idx) + len(part2)
        text = text[:end_idx] + "\n" + new_svgs + text[end_idx:]

    react_panda_func = """
  var buddyReactionTimer = null;
  function reactPanda(state, ms) {
    if (!pandaBuddyEl) return;
    var prev = (buddyState !== 'camera' && buddyState !== 'dead' && buddyState !== 'happy' && buddyState !== 'shocked') ? buddyState : 'idle';
    if(state === 'idle') { setBuddyState('idle'); return; }
    stopBuddyAmbient();
    pandaBuddyEl.className = 'panda-buddy panda-buddy--' + state;
    var svgs = {
      idle: BUDDY_IDLE, thinking: BUDDY_THINKING,
      working: BUDDY_WORKING, happy: BUDDY_HAPPY,
      sad: BUDDY_SAD, sleeping: BUDDY_SLEEPING,
      camera: BUDDY_CAMERA, dead: BUDDY_DEAD, shocked: BUDDY_SHOCKED
    };
    pandaBuddyEl.innerHTML = svgs[state] || svgs.idle;
    clearTimeout(buddyIdleTimer);
    clearTimeout(buddyReactionTimer);
    buddyReactionTimer = setTimeout(function() { 
      setBuddyState(prev); 
    }, ms || 2500);
  }
"""
    # Insert reactPanda after petPanda
    pet_panda_end = "  function petPanda() {\n    var prev = buddyState;\n    stopBuddyAmbient();\n    pandaBuddyEl.className = 'panda-buddy panda-buddy--pet';\n    pandaBuddyEl.innerHTML = BUDDY_HAPPY;\n    clearTimeout(buddyIdleTimer);\n    setTimeout(function() { setBuddyState(prev === 'pet' ? 'idle' : prev); }, 1500);\n  }"
    text = text.replace(pet_panda_end, pet_panda_end + "\n" + react_panda_func)

    tool_call_original = """    toolCall(msg) {
      streamingEntry = null;
      addEntry(msg.label || 'Worker', escapeHtml(msg.text), 'tool-call', msg.text);"""

    tool_call_replacement = """    toolCall(msg) {
      streamingEntry = null;
      addEntry(msg.label || 'Worker', escapeHtml(msg.text), 'tool-call', msg.text);

      var lowerDesc = (msg.text || '').toLowerCase();
      if (lowerDesc.includes('update_step_result') || lowerDesc.includes('update_test_status') || lowerDesc.includes('complete_test_run') || lowerDesc.includes('update_step')) {
        if (lowerDesc.includes('"pass"') || lowerDesc.includes('pass') || lowerDesc.includes('"passing"')) {
          reactPanda('happy', 3000);
        } else if (lowerDesc.includes('"fail"') || lowerDesc.includes('fail') || lowerDesc.includes('"failing"')) {
          reactPanda('dead', 4000);
        } else {
          reactPanda('working', 2000);
        }
      } else if (lowerDesc.includes('capture_screenshot') || lowerDesc.includes('capturescreenshot') || (lowerDesc.includes('chrome_devtools') && lowerDesc.includes('screenshot')) || lowerDesc.includes('chrome-devtools')) {
        reactPanda('camera', 3000);
      } else if (lowerDesc.includes('run_command') || lowerDesc.includes('execute') || lowerDesc.includes('shell') || lowerDesc.includes('run_test') || lowerDesc.includes('terminal')) {
        reactPanda('working', 2500);
      } else {
        reactPanda('thinking', 2000);
      }
"""
    text = text.replace(tool_call_original, tool_call_replacement)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(text)

def update_style_css():
    file_path = "extension/webview/style.css"
    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()

    css_inject_point = ".panda-buddy--pet      { animation: panda-wiggle 0.4s ease-in-out 3; }"
    new_animations = """
.panda-buddy--dead     { animation: panda-collapse 1.5s forwards; }
.panda-buddy--shocked  { animation: panda-shake-fast 0.4s ease-in-out infinite; }
.panda-buddy--camera   { animation: panda-pop-flash 1s forwards; }"""
    
    text = text.replace(css_inject_point, css_inject_point + new_animations)

    keyframes = """
@keyframes panda-collapse {
  0% { transform: scale(1) rotate(0deg); opacity: 1; }
  20% { transform: scale(1.1) rotate(-15deg); }
  100% { transform: scale(0.9) translateY(40px) rotate(-90deg); opacity: 0.5; }
}
@keyframes panda-shake-fast {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px) translateY(-2px); }
  75% { transform: translateX(4px) translateY(2px); }
}
@keyframes panda-pop-flash {
  0% { transform: scale(1); }
  15% { transform: scale(1.15) rotate(-5deg); }
  30% { transform: scale(1); }
  100% { transform: scale(1); }
}
"""
    text += keyframes

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(text)

print("Running python updaters...")
update_main_js()
update_style_css()
print("Done.")
