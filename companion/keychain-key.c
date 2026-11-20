#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>

/* A key never enters argv or the environment. Node captures its binary stdout. */
static OSStatus read_key(CFStringRef service, CFStringRef account, CFDataRef *key) {
  const void *keys[] = {kSecClass, kSecAttrService, kSecAttrAccount,
                        kSecReturnData, kSecMatchLimit};
  const void *values[] = {kSecClassGenericPassword, service, account,
                          kCFBooleanTrue, kSecMatchLimitOne};
  CFDictionaryRef query = CFDictionaryCreate(NULL, keys, values, 5,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  OSStatus status = SecItemCopyMatching(query, (CFTypeRef *)key);
  CFRelease(query);
  return status;
}

int main(int argc, char **argv) {
  if (argc != 4 || (strcmp(argv[1], "get") && strcmp(argv[1], "create"))) return 2;
  CFStringRef service = CFStringCreateWithCString(NULL, argv[2], kCFStringEncodingUTF8);
  CFStringRef account = CFStringCreateWithCString(NULL, argv[3], kCFStringEncodingUTF8);
  if (!service || !account) return 2;
  CFDataRef key = NULL;
  OSStatus status = read_key(service, account, &key);
  if (status == errSecItemNotFound && !strcmp(argv[1], "create")) {
    unsigned char bytes[32];
    status = SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes);
    if (status == errSecSuccess) {
      CFDataRef created = CFDataCreate(NULL, bytes, sizeof(bytes));
      volatile unsigned char *wipe = bytes;
      for (size_t i = 0; i < sizeof(bytes); i++) wipe[i] = 0;
      const void *keys[] = {kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData,
                            kSecAttrLabel};
      const void *values[] = {kSecClassGenericPassword, service, account, created,
                              CFSTR("Lookahead Subtitles credential encryption")};
      CFDictionaryRef item = CFDictionaryCreate(NULL, keys, values, 5,
          &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
      status = SecItemAdd(item, NULL);
      CFRelease(item);
      CFRelease(created);
      if (status == errSecSuccess || status == errSecDuplicateItem)
        status = read_key(service, account, &key);
    }
  }
  CFRelease(service);
  CFRelease(account);
  if (status != errSecSuccess || !key || CFGetTypeID(key) != CFDataGetTypeID() ||
      CFDataGetLength(key) != 32) {
    if (key) CFRelease(key);
    fprintf(stderr, "Credential Keychain access failed (%d).\n", (int)status);
    return 1;
  }
  size_t written = fwrite(CFDataGetBytePtr(key), 1, 32, stdout);
  CFRelease(key);
  return written == 32 ? 0 : 1;
}
