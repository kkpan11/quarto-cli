-- mediabag.lua
-- Copyright (C) 2024 Posit Software, PBC

-- helpers for working with the pandoc mediabag

local filenames = require 'modules/filenames'

-- A cache of image urls that we've resolved into the mediabag
-- keyed by {url: mediabagpath}
local resolved_url_cache = {}

-- calls the callback with two parameters: the mimetype of found mediabag entry
-- and a path to a temporary file containing its contents. If the mediabag entry
-- is not found, the callback is called with nil
local function with_mediabag_contents(src, callback)
  local mt, contents = pandoc.mediabag.lookup(src)
  if mt == nil then
    return callback(nil)
  end
  return pandoc.system.with_temporary_directory("with_mediabag_contents", function (tmpdir)
    local filename = src
    local tempPath = pandoc.path.join({tmpdir, filename})
    assert(_quarto.file.write(tempPath, contents))
    return callback(mt, tempPath)
  end)
end

local function fetch_and_store_image(src)
  local imgMt, imgContents = pandoc.mediabag.fetch(src)
  if imgMt == nil then
    return nil
  end
  assert(imgContents)

  local decodedSrc = fullyUrlDecode(src)                
  if decodedSrc == nil then
    decodedSrc = "unknown"
  end

  -- compute the filename for this file
  local basefilename = pandoc.path.filename(decodedSrc)
  local safefilename = filenames.windows_safe_filename(filenames.tex_safe_filename(basefilename))
  local filename = filenames.filename_from_mime_type(safefilename, imgMt)

  local existingMt = pandoc.mediabag.lookup(filename)
  local counter = 1
  while (existingMt) do
    local stem, ext = pandoc.path.split_extension(filename)
    filename = stem .. counter .. ext
    existingMt = pandoc.mediabag.lookup(filename)
    counter = counter + 1
  end
  resolved_url_cache[src] = filename
  pandoc.mediabag.insert(filename, imgMt, imgContents)
  return filename
end

local function should_mediabag(src)
  local relativePath = src:match("https?://[%w%$%-%_%.%+%!%*%'%(%)%:%%]+/(.+)") or
    src:match("data:image/.+;base64,(.+)")
  return relativePath or param("has-resource-path", false)
end

local function resolve_image_from_url(image)
  if resolved_url_cache[image.src] then
    image.src = resolved_url_cache[image.src]
    return image
  end 
  if not should_mediabag(image.src) then
    return nil
  end
  local filename = fetch_and_store_image(image.src)
  if filename == nil then
    return nil
  end
  image.src = filename
  return image
end

local function write_mediabag_entry(src)
  local mt, contents = pandoc.mediabag.lookup(src)
  if contents == nil then return nil end

  local mediabagDir = param("mediabag-dir", nil)
  local mediaFile = pandoc.path.join{mediabagDir, src}

  local file = _quarto.file.write(mediaFile, contents)
  if not file then
    warn('failed to write mediabag entry: ' .. mediaFile)
  end
  return mediaFile
end

return {
  resolved_url_cache = resolved_url_cache,
  with_mediabag_contents = with_mediabag_contents,
  fetch_and_store_image = fetch_and_store_image,
  should_mediabag = should_mediabag,
  resolve_image_from_url = resolve_image_from_url,
  write_mediabag_entry = write_mediabag_entry
}