import {
  LanguageModelV1FilePart,
  LanguageModelV1ImagePart,
  LanguageModelV1Message,
  LanguageModelV1Prompt,
  LanguageModelV1TextPart,
} from '@ai-sdk/provider';
import { getErrorMessage } from '@ai-sdk/provider-utils';
import { download } from '../../util/download';
import { CoreMessage } from '../prompt/message';
import { detectImageMimeType } from '../util/detect-image-mimetype';
import { FilePart, ImagePart, TextPart } from './content-part';
import { convertDataContentToUint8Array } from './data-content';
import { ValidatedPrompt } from './get-validated-prompt';
import { InvalidMessageRoleError } from './invalid-message-role-error';

export async function convertToLanguageModelPrompt({
  prompt,
  modelSupportsImageUrls = true,
  downloadImplementation = download,
}: {
  prompt: ValidatedPrompt;
  modelSupportsImageUrls: boolean | undefined;
  downloadImplementation?: typeof download;
}): Promise<LanguageModelV1Prompt> {
  const languageModelMessages: LanguageModelV1Prompt = [];

  if (prompt.system != null) {
    languageModelMessages.push({ role: 'system', content: prompt.system });
  }

  // Assumption: if the model supports image downloading, it also supports file downloading
  const modelSupportsFileUrls = modelSupportsImageUrls;

  const downloadedImages =
    modelSupportsImageUrls || prompt.messages == null
      ? null
      : await downloadImages(prompt.messages, downloadImplementation);

  const downloadedFiles =
    modelSupportsFileUrls || prompt.messages == null
      ? null
      : await downloadFiles(prompt.messages, downloadImplementation);

  const promptType = prompt.type;
  switch (promptType) {
    case 'prompt': {
      languageModelMessages.push({
        role: 'user',
        content: [{ type: 'text', text: prompt.prompt }],
      });
      break;
    }

    case 'messages': {
      languageModelMessages.push(
        ...prompt.messages.map(
          (message): LanguageModelV1Message =>
            convertToLanguageModelMessage(
              message,
              downloadedImages,
              downloadedFiles,
            ),
        ),
      );
      break;
    }

    default: {
      const _exhaustiveCheck: never = promptType;
      throw new Error(`Unsupported prompt type: ${_exhaustiveCheck}`);
    }
  }

  return languageModelMessages;
}

/**
 * Convert a CoreMessage to a LanguageModelV1Message.
 *
 * @param message The CoreMessage to convert.
 * @param downloadedImages A map of image URLs to their downloaded data. Only
 *   available if the model does not support image URLs, null otherwise.
 * @param downloadedFiles A map of file URLs to their downloaded data. Only
 *  available if the model does not support file URLs, null otherwise.
 */
export function convertToLanguageModelMessage(
  message: CoreMessage,
  downloadedImages: Record<
    string,
    { mimeType: string | undefined; data: Uint8Array }
  > | null,
  downloadedFiles: Record<
    string,
    { mimeType: string | undefined; data: Uint8Array }
  > | null,
): LanguageModelV1Message {
  const role = message.role;
  switch (role) {
    case 'system': {
      return { role: 'system', content: message.content };
    }

    case 'user': {
      if (typeof message.content === 'string') {
        return {
          role: 'user',
          content: [{ type: 'text', text: message.content }],
        };
      }

      return {
        role: 'user',
        content: message.content.map(
          (
            part,
          ):
            | LanguageModelV1TextPart
            | LanguageModelV1ImagePart
            | LanguageModelV1FilePart => {
            switch (part.type) {
              case 'text': {
                return part;
              }

              case 'image': {
                if (part.image instanceof URL) {
                  if (downloadedImages == null) {
                    return {
                      type: 'image',
                      image: part.image,
                      mimeType: part.mimeType,
                    };
                  } else {
                    const downloadedImage =
                      downloadedImages[part.image.toString()];
                    return {
                      type: 'image',
                      image: downloadedImage.data,
                      mimeType: part.mimeType ?? downloadedImage.mimeType,
                    };
                  }
                }

                // try to convert string image parts to urls
                if (typeof part.image === 'string') {
                  try {
                    const url = new URL(part.image);

                    switch (url.protocol) {
                      case 'http:':
                      case 'https:': {
                        if (downloadedImages == null) {
                          return {
                            type: 'image',
                            image: url,
                            mimeType: part.mimeType,
                          };
                        } else {
                          const downloadedImage = downloadedImages[part.image];
                          return {
                            type: 'image',
                            image: downloadedImage.data,
                            mimeType: part.mimeType ?? downloadedImage.mimeType,
                          };
                        }
                      }
                      case 'data:': {
                        try {
                          const [header, base64Content] = part.image.split(',');
                          const mimeType = header.split(';')[0].split(':')[1];

                          if (mimeType == null || base64Content == null) {
                            throw new Error('Invalid data URL format');
                          }

                          return {
                            type: 'image',
                            image:
                              convertDataContentToUint8Array(base64Content),
                            mimeType,
                          };
                        } catch (error) {
                          throw new Error(
                            `Error processing data URL: ${getErrorMessage(
                              message,
                            )}`,
                          );
                        }
                      }
                      default: {
                        throw new Error(
                          `Unsupported URL protocol: ${url.protocol}`,
                        );
                      }
                    }
                  } catch (_ignored) {
                    // not a URL
                  }
                }

                const imageUint8 = convertDataContentToUint8Array(part.image);

                return {
                  type: 'image',
                  image: imageUint8,
                  mimeType: part.mimeType ?? detectImageMimeType(imageUint8),
                };
              }

              case 'file': {
                if (part.file instanceof URL) {
                  if (downloadedFiles == null) {
                    return {
                      type: 'file',
                      file: part.file,
                      mimeType: part.mimeType,
                    };
                  } else {
                    const downloadedFile =
                      downloadedFiles[part.file.toString()];
                    return {
                      type: 'file',
                      file: downloadedFile.data,
                      mimeType: part.mimeType,
                    };
                  }
                }

                // try to convert string file parts to urls
                if (typeof part.file === 'string') {
                  try {
                    const url = new URL(part.file);

                    switch (url.protocol) {
                      case 'gs:': {
                        return {
                          type: 'file',
                          file: url,
                          mimeType: part.mimeType,
                        };
                      }

                      case 'http:':
                      case 'https:': {
                        if (downloadedFiles == null) {
                          return {
                            type: 'file',
                            file: url,
                            mimeType: part.mimeType,
                          };
                        } else {
                          const downloadedFile = downloadedFiles[part.file];
                          return {
                            type: 'file',
                            file: downloadedFile.data,
                            mimeType: part.mimeType,
                          };
                        }
                      }
                      case 'data:': {
                        try {
                          const [header, base64Content] = part.file.split(',');
                          const mimeType = header.split(';')[0].split(':')[1];

                          if (mimeType == null || base64Content == null) {
                            throw new Error('Invalid data URL format');
                          }

                          return {
                            type: 'file',
                            file: convertDataContentToUint8Array(base64Content),
                            mimeType,
                          };
                        } catch (error) {
                          throw new Error(
                            `Error processing data URL: ${getErrorMessage(
                              message,
                            )}`,
                          );
                        }
                      }
                      default: {
                        throw new Error(
                          `Unsupported URL protocol: ${url.protocol}`,
                        );
                      }
                    }
                  } catch (_ignored) {
                    // not a URL
                  }
                }

                const fileUint8 = convertDataContentToUint8Array(part.file);

                return {
                  type: 'file',
                  file: fileUint8,
                  mimeType: part.mimeType,
                };
              }
            }
          },
        ),
      };
    }

    case 'assistant': {
      if (typeof message.content === 'string') {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: message.content }],
        };
      }

      return {
        role: 'assistant',
        content: message.content.filter(
          // remove empty text parts:
          part => part.type !== 'text' || part.text !== '',
        ),
      };
    }

    case 'tool': {
      return message;
    }

    default: {
      const _exhaustiveCheck: never = role;
      throw new InvalidMessageRoleError({ role: _exhaustiveCheck });
    }
  }
}

async function downloadImages(
  messages: CoreMessage[],
  downloadImplementation: typeof download,
): Promise<Record<string, { mimeType: string | undefined; data: Uint8Array }>> {
  const urls = messages
    .filter(message => message.role === 'user')
    .map(message => message.content)
    .filter((content): content is Array<TextPart | ImagePart | FilePart> =>
      Array.isArray(content),
    )
    .flat()
    .filter((part): part is ImagePart => part.type === 'image')
    .map(part => part.image)
    .map(part =>
      // support string urls in image parts:
      typeof part === 'string' &&
      (part.startsWith('http:') || part.startsWith('https:'))
        ? new URL(part)
        : part,
    )
    .filter((image): image is URL => image instanceof URL);

  // download images in parallel:
  const downloadedImages = await Promise.all(
    urls.map(async url => ({
      url,
      data: await downloadImplementation({ url }),
    })),
  );

  return Object.fromEntries(
    downloadedImages.map(({ url, data }) => [url.toString(), data]),
  );
}

async function downloadFiles(
  messages: CoreMessage[],
  downloadImplementation: typeof download,
): Promise<Record<string, { mimeType: string | undefined; data: Uint8Array }>> {
  const urls = messages
    .filter(message => message.role === 'user')
    .map(message => message.content)
    .filter((content): content is Array<TextPart | ImagePart | FilePart> =>
      Array.isArray(content),
    )
    .flat()
    .filter((part): part is FilePart => part.type === 'file')
    .map(part => part.file)
    .map(part =>
      // support string urls in file parts:
      typeof part === 'string' &&
      (part.startsWith('http:') || part.startsWith('https:'))
        ? new URL(part)
        : part,
    )
    .filter((file): file is URL => file instanceof URL);

  // download files in parallel:
  const downloadedFiles = await Promise.all(
    urls.map(async url => ({
      url,
      data: await downloadImplementation({ url }),
    })),
  );

  return Object.fromEntries(
    downloadedFiles.map(({ url, data }) => [url.toString(), data]),
  );
}
