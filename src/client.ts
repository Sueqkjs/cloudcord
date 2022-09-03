import {
  APIApplicationCommandInteraction,
  InteractionResponseType,
  APIInteractionResponseCallbackData,
  LocaleString,
  APIAttachment,
  InteractionType,
  APIPingInteraction,
  APIMessageComponentInteraction,
  APIModalSubmitInteraction,
  APIInteractionResponse,
  APIApplicationCommandInteractionDataOption,
  APIApplicationCommandAutocompleteInteraction,
} from "discord-api-types/v10";
import { verify } from "./verify";

export default class<T extends Env, C extends Record<LocaleString | "en", Record<string, CommandOption>>> {
  commands: ICommands;
  env: T;
  clientId: string;
  config: C;
  constructor(env: T, config: C) {
    this.commands = {};
    this.env = env;
    this.clientId = atob(env.token.split(".")[0]);
    this.config = config;
  }

  async request(request: Request): Promise<Response> {
    if (
      !request.headers.get("X-Signature-Ed25519") ||
      !request.headers.get("X-Signature-Timestamp") ||
      !(await verify(request, this.env.publicKey))
    )
      return new Response("", { status: 401 });
    const interaction = (await request.json()) as
      | APIPingInteraction
      | APIApplicationCommandInteraction
      | APIApplicationCommandAutocompleteInteraction
      | APIMessageComponentInteraction
      | APIModalSubmitInteraction;
    switch (interaction.type) {
      case InteractionType.Ping:
        return this.respond({
          type: InteractionResponseType.Pong,
        });
      case InteractionType.ApplicationCommand:
        return this.respond(
          await this.commands[interaction.data.name](interaction)
        );
      case InteractionType.ApplicationCommandAutocomplete:
        let choices =
          this.commands[interaction.data.name].options
            ?.filter((x) =>
              interaction.data.options.find(
                (y) => x.name === y.name && x.type === y.type
              )
            )
            .map((x) => x.autoComplete) || [];
          // なぜかエラーが出ているが気にしないことにした。
        return this.respond({
          type: InteractionResponseType.ApplicationCommandAutocompleteResult,
          data: {
            choices,
          },
        });
      default:
        return this.respond(this.reply("hi"));
    }
  }

  command(args: SlashCommandOption | UserOrMessageCommandOption) {
    let self = this;
    return function (
      _target: Object,
      name: string,
      descriptor: PropertyDescriptor
    ) {
      let fn = descriptor.value as Command;
      if (args.type === 2 || args.type === 3) {
        fn.type = args.type;
        fn.name_localizations = args.name_localizations;
        self.commands[args.name] = fn;
      } else if (args.type === 1) {
        if (args.options) fn.options = args.options;
        fn.type = 1;
        fn.description = args.description;
        fn.description_localizations = args.description_localizations;
        self.commands[name] = fn;
      }
    };
  }

  async register() {
    let i = Object.entries(this.commands).map(([name, command]) => {
      return { name, ...command };
    });
    return await fetch(
      `https://discord.com/api/v9/applications/${this.clientId}/commands`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: `Bot ${this.env.token}`,
        },
        body: JSON.stringify(i),
      }
    )
      .then(async (r) => await r.json())
      .catch((e) => e);
  }

  help(locale?: string) {
    let str = "";
    for (let [key, val] of Object.entries(this.commands)) {
      let desc;
      switch (val.type) {
        case 1:
          if (
            val.description_localizations &&
            locale &&
            val.description_localizations[locale]
          ) {
            desc = val.description_localizations[locale];
          } else {
            desc = val.description;
          }
          str += key + ":\n  " + desc + "\n\n";
          break;
      }
    }
    return "```\n" + str + "```";
  }
  reply(
    data:
      | APIInteractionResponseCallbackData & {
          attachments?: (Pick<APIAttachment, "id" | "description"> &
            Pick<APIAttachment, "filename"> & { data: Blob })[];
        } & { ephemeral?: boolean; supppress_embeds?: boolean }
  ): FormData;
  reply(data: string): FormData;
  reply(
    data:
      | (APIInteractionResponseCallbackData & {
          attachments?: (Pick<APIAttachment, "id" | "description"> &
            Pick<APIAttachment, "filename"> & { data: Blob })[];
        } & { ephemeral?: boolean; supppress_embeds?: boolean })
      | string
  ): FormData {
    const form = new FormData();
    if (typeof data === "string") {
      form.append(
        "payload_json",
        JSON.stringify({
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: data,
          },
        })
      );
    } else {
      let flags = 0;
      if (data.ephemeral) flags = 1 << 6;
      if (data.supppress_embeds) flags = flags | (1 << 2);
      form.append(
        "payload_json",
        JSON.stringify({
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            flags,
            ...data,
          },
        })
      );
      if (data.attachments)
        for (let attachment of data.attachments) {
          form.append(
            `files[${attachment.id}]`,
            attachment.data,
            attachment.filename
          );
        }
    }
    return form;
  }

  error(
    command: string,
    error: string,
    raw: C & { en: any },
    locale?: keyof typeof raw
  ): FormData {
    return this.reply({
      content: this.format(raw[locale || "en"][command].error!, error),
      ephemeral: true,
    });
  }

  toSupportedLocale(locale: LocaleString, raw: C) {
    let loc: string = locale;
    if (locale.startsWith("en-")) loc = "en";
    if (!Object.keys(raw).includes(loc)) return "en";
    return loc as keyof typeof raw;
  }

  respond(interaction: FormData | APIInteractionResponse): Response {
    let i: FormData;
    if (!(interaction instanceof FormData)) {
      let form = new FormData();
      form.append("payload_json", JSON.stringify(interaction));
      i = form;
    } else {
      i = interaction;
    }
    return new Response(i);
  }

  format(...r: string[]): string {
    return r.reduce(
      (a, c, i) => a?.replace(new RegExp(`\\{${i}\\}`, "g"), c),
      r.shift()
    ) as string;
  }
}

export interface ICommands {
  [key: string]: Command;
}

export interface CommandOption {
  type: Number;
  description?: string;
  description_localizations?: Record<string, string>;
  name_localizations?: Record<string, string>;
  name?: string;
  options?: ({
    autoComplete: string | number;
  } & APIApplicationCommandInteractionDataOption)[];
  error?: string;
}

export interface SlashCommandOption extends CommandOption {
  type: 1;
  description: string;
  description_localizations: Record<string, string>;
  options?: ({
    autoComplete: string | number;
  } & APIApplicationCommandInteractionDataOption)[];
}

export interface UserOrMessageCommandOption extends CommandOption {
  type: 2 | 3;
  name_localizations: Record<string, string>;
  name: string;
}

export interface Command extends CommandOption {
  (i: APIApplicationCommandInteraction): Promise<FormData>;
}

interface Env {
  publicKey: string;
  token: string;
}
