export function sanitize(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[​-‍﻿⁠]/g, '')
    .replace(/[‪-‮⁦-⁩]/g, '');
}
