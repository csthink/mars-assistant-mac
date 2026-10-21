// Read-only AppKit hit test for the background integration client (mac-feature-t11:KB-04): which view of the
// window would receive a mouse event at a point given in content coordinates from the top left. No event is sent.
#import <AppKit/AppKit.h>
#include <node_api.h>
static napi_value Hit(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  void* data = nullptr;
  size_t size = 0;
  double x = 0, y = 0;
  if (argc != 3 || napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size != sizeof(void*) ||
      napi_get_value_double(env, args[1], &x) != napi_ok || napi_get_value_double(env, args[2], &y) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a live window handle and a point");
    return nullptr;
  }
  NSView* root = ((__bridge NSView*)(*static_cast<void**>(data))).window.contentView;
  NSPoint point = NSMakePoint(x, root.isFlipped ? y : root.bounds.size.height - y);
  NSView* hit = [root hitTest:[root convertPoint:point toView:root.superview]];
  NSRect frame = hit ? [hit convertRect:hit.bounds toView:root] : NSZeroRect;
  NSDictionary* result = @{
    @"class" : hit ? NSStringFromClass(hit.class) : @"",
    @"x" : @(frame.origin.x),
    @"y" : @(root.bounds.size.height - NSMaxY(frame)),
    @"width" : @(frame.size.width),
    @"height" : @(frame.size.height),
  };
  NSData* json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  napi_value value;
  napi_create_string_utf8(env, static_cast<const char*>(json.bytes), json.length, &value);
  return value;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor p[] = {{"hit", nullptr, Hit, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 1, p);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
