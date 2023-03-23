"use strict";(self.webpackChunkwebsite=self.webpackChunkwebsite||[]).push([[1075],{1229:e=>{e.exports=JSON.parse('{"blogPosts":[{"id":"Sequential GUIDs in EF Core Might Not Be Sequential","metadata":{"permalink":"/website/blog/Sequential GUIDs in EF Core Might Not Be Sequential","editUrl":"https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/blog/2023-02-27-Sequential-Guids/index.md","source":"@site/blog/2023-02-27-Sequential-Guids/index.md","title":"Sequential GUIDs in EF Core Might Not Be Sequential","description":"The Background","date":"2023-02-27T00:00:00.000Z","formattedDate":"February 27, 2023","tags":[{"label":"ef core","permalink":"/website/blog/tags/ef-core"},{"label":"c#","permalink":"/website/blog/tags/c"},{"label":"dotnet","permalink":"/website/blog/tags/dotnet"}],"readingTime":11.475,"hasTruncateMarker":false,"authors":[{"name":"Conner Phillis","title":"Lead Developer, Keymark Labs","url":"https://github.com/connerphillis","imageURL":"https://github.com/connerphillis.png","key":"conner"}],"frontMatter":{"slug":"Sequential GUIDs in EF Core Might Not Be Sequential","title":"Sequential GUIDs in EF Core Might Not Be Sequential","authors":["conner"],"tags":["ef core","c#","dotnet"]},"nextItem":{"title":"Welcome","permalink":"/website/blog/welcome"}},"content":"### The Background\\r\\n\\r\\nOur customers more often than not chose to host our application on their own machines, so we frequently get asked what the minimum hardware requirements are. We base the estimates we provide on the requirements of similar applications, but we had never put in the work to really test our application and see what sort of throughput we could expect.\\r\\n\\r\\nWe decided to finally get a conclusive answer for ourselves, so we would put some resources into running benchmarks. We settled on a simple setup. Write a simple script that would simulate a series of requests that would run through hot paths, and see how many operations we could complete in a fixed time frame. The script would run X number of concurrent requests for N minutes, log the statistics to a CSV file and export our results to a CSV file for analysis.\\r\\n\\r\\nWe architected our test server to simulate an organization stressed for resources. On a single virtual machine we installed SQL Server, IIS, and our application. For the hardware behind the virtual machine we used an Azure F4s v2 (4 vCPU, 8GB).\\r\\n\\r\\nFor our warm up, we ran the script with 20 concurrent tasks for 10 minutes, the results that we got?\\r\\n\\r\\n```\\r\\n263724 total requests completed\\r\\n67431 form submissions in 10 minutes across 20 tasks\\r\\n```\\r\\n\\r\\nWhile this may not seem like a lot for some, this was great for us. We consider our workloads somewhat computationally expensive, and didn\'t imagine we would get these sort of numbers out of our code. Especially when hosting the server and database on the same machine.\\r\\n\\r\\nOur logs indicated that we were on average consuming about 70% of the CPU. The data that we got was plenty for us to determine our hardware requirements, but just for fun we decided to see how far we could push it. We resized the VM to an F8s V2 (8 vCPU 16GB) expecting linear results.\\r\\n\\r\\nThe script was set, 50 concurrent tasks instead of 20 to account for the increase in core count,running for ten minutes. The results?\\r\\n```\\r\\n275532 total requests completed\\r\\n68883 form submissions in 10 minute across 50 tasks.\\r\\n```\\r\\n\\r\\n**_What!?!?_** We doubled the hardware, 2.5x\'d the number of concurrent runs, and ended up with only ~3% more completed requests. This set off an alarm for us, we obviously had a large issue with the scalability of our application.\\r\\n\\r\\n### Investigating the Issue\\r\\n\\r\\nThe first thing that we theorized was that the increased number of tasks was causing problems with IIS, causing connections to stay open for longer than they should. We altered our the parameters of our test script to use 20 tasks over 10 minutes, mirroring the test against the F4s machine. After 10 minutes, the results were...\\r\\n\\r\\n```\\r\\n275916 total requests completed\\r\\n68979 form submissions in 10 minutes across 10 tasks\\r\\n```\\r\\n__*The same??*__ There was only a marginal difference in the results. Less than 1% from the original run. The test machine was hardly using a fraction of the processing power and network it could utilize. Something bigger was afoot.\\r\\n\\r\\nWe started a Remote Desktop session with the server and ran another test, 10 minutes, 20 cores. We observed SQL Server start by consuming ~30% of our CPU time, and watched it move up to as much as 60% of the CPU by the end of the run. Over time, our performance was getting *worse*.\\r\\n\\r\\nOn a whim, we ran a query to check for index fragmentation of the database.\\r\\n\\r\\n![Production Index Fragmentation](./Production-Index-Fragmentation.png)\\r\\n\\r\\nThe index fragmentation was far above what could be expected out of a healthy database. North of 50% for some indexes. While we can\'t *prove* right now that this is what is causing our scaling issue<sup>[1](#footnote1)</sup> it does explain how SQL server can continuously need more resources. As the size of the data grows, SQL is having to spend more time doing table scans and expending more resources on IO.\\r\\n\\r\\nWe found this puzzling, we were using Entity Framework Core\'s [`Sequential Guid Value Generator`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.valuegeneration.sequentialguidvaluegenerator?view=efcore-7.0) With the [`DatabaseGeneratedOption.Identity`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations.schema.databasegeneratedoption?view=net-7.0) option. The documentation states:\\r\\n> Generates sequential Guid values optimized for use in Microsoft SQL server clustered keys or indexes, yielding better performance than random values. This is the default generator for SQL Server Guid columns which are set to be generated on add.\\r\\n\\r\\nIt\'s important to note in addition to this documentation for those that aren\'t aware, setting a column to use a GUID as a key with `DatabaseGeneratedOption.Identity` **does not mean that it will be generated by the database**. Instead, EF Core generates the sequential GUID itself, and then inserts it into the database ([read here](https://weblogs.asp.net/ricardoperes/current-limitations-of-entity-framework-core#:~:text=For%20GUIDs%2C%20EF%20Core%20automatically%20generates%2C%20on%20the,makes%20it%20database-specific%20%E2%80%93%20currently%2C%20SQL%20Server%20only.)). This can be observed when comparing GUIDs generated normally to those generated by `NEWSEQUENTIALID` later in this post.\\r\\n\\r\\nAdditionally, [this issue](https://github.com/dotnet/efcore/pull/20528#issuecomment-612889464) in the EF core repository shows that EF core generates GUIDs *better* than SQL Server does. The documentation wasn\'t lining up with what we were seeing, it was time to recreate the EF tests, and see if we could simulate the behavior we were getting from our server.\\r\\n\\r\\n### Running our Own Benchmarks\\r\\n\\r\\nThe first thing we did was see if we could reproduce the test done by [roji](https://github.com/roji) on the EF core team with 100000. And...\\r\\n\\r\\n| Method | Average page space used in % | Average fragmentation in percent | Record Count\\r\\n| --- | ---: | ---: | ---: |\\r\\n| NEWSEQUENTIALID | 99.91 % | 1.04 % | 100000 |\\r\\n| EF Core Sequential Guid Value Generator | 99.86 % | 0.56 % | 100000 |\\r\\n\\r\\nSame results as the team found. The EF Core value generator is still generating GUIDs optimally as of SQL Server 2022.\\r\\n\\r\\nBut wait... this isn\'t really how a web server works. Entities aren\'t just inserted one after another when coming from a web server. Entries are created in response to user activity, and that can happen whenever. Database activity happens spontaneously, whenever a user performs an action, and different user hardware can mean these operations can take different amounts of time. What if we modify the test, instead to simulate a large degree of parallel actions rather than pure sequential inserts? \\r\\n\\r\\nWe altered our script, instead of inserting 100,000 sequential ids into the database, we created 20 tasks, and told each of those tasks to insert 5000 rows into the database. Once this was done we looked at index fragmentation again.\\r\\n\\r\\n##### Parallel Entity Framework Sequential Guid Generation\\r\\n| average page space used in % | average fragmentation in percent | Record Count\\r\\n| ---: | ---: | ---: |\\r\\n| 57.93 % | 44.53 % | 100000 |\\r\\n\\r\\n<details>\\r\\n<summary>Multithreaded Simulation Code</summary>\\r\\n\\r\\n```csharp\\r\\nclass Program\\r\\n{\\r\\n  static async Task Main(string[] args)\\r\\n  {\\r\\n    await using var globalCtx = new BlogContext();\\r\\n    await globalCtx.Database.EnsureDeletedAsync();\\r\\n    await globalCtx.Database.EnsureCreatedAsync();\\r\\n    await globalCtx.DisposeAsync();\\r\\n\\r\\n    var counter = 0;\\r\\n\\r\\n    var tasks = new List<Task>();\\r\\n    for (int i = 0; i < 20; i++)\\r\\n    {\\r\\n      var t = Task.Run(async () =>\\r\\n      {\\r\\n        await using var ctx = new BlogContext();\\r\\n\\r\\n        for (var j = 0; j < 5000; j++)\\r\\n        {\\r\\n          var value = Interlocked.Increment(ref counter);\\r\\n          ctx.Blogs.Add(new Blog { Name = \\"Foo\\" + value });\\r\\n          await ctx.SaveChangesAsync();\\r\\n        }\\r\\n      });\\r\\n\\r\\n      tasks.Add(t);\\r\\n    }\\r\\n\\r\\n    await Task.WhenAll(tasks);\\r\\n  }\\r\\n}\\r\\n\\r\\npublic class BlogContext : DbContext\\r\\n{\\r\\n  public DbSet<Blog> Blogs { get; set; }\\r\\n\\r\\n  protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)\\r\\n    => optionsBuilder.UseSqlServer(\\"Server=.;Database=Testing;Trusted_Connection=true;Encrypt=false;\\");\\r\\n}\\r\\n\\r\\npublic class Blog\\r\\n{\\r\\n  public Guid Id { get; set; }\\r\\n  public string Name { get; set; }\\r\\n}\\r\\n```\\r\\n\\r\\n</details>\\r\\n\\r\\nThe top 10 results returned when querying the database illuminate the issue: ![TOP 10 Results From SequentialGuidValueGenerator](./Sequential-Guid-Value-Generator-Order.png)\\r\\n\\r\\nOur conclusion? **Entity Framework seeks to create an efficient value generation strategy optimized for SQL Server, but after the network stack has its say, its likely that some rows will be inserted out of their original order.**\\r\\n\\r\\nCompare that to the results that you get when running the same code, but setting `HasDefaultValueSql(\\"NEWSEQUENTIALID()\\")` in the `OnModelCreating` method in the database context:\\r\\n\\r\\n##### Parallel Guid Generation with NEWSEQUENTIALID()\\r\\n| average page space used in % | average fragmentation in percent | Record Count\\r\\n| ---: | ---: | ---: |\\r\\n| 96.03 % | 7.67 % | 100000 |\\r\\n\\r\\nThe fragmentation percentage is still not as good as inserting the rows one after the other, and the average page space used is a bit lower, but I think we can all agree that it\'s better than generating the IDs in memory with Entity Framework Core.\\r\\n\\r\\nThis method has drawbacks too, however. Looking at the GUIDs that SQL generates it\'s hard to say that they have the same uniqueness guarantee that standard GUIDs have. It appears that the leading bits of the GUIDs are all that change when taking a sample of the first 10 inserted in the database after our concurrent test:\\r\\n\\r\\n![NEWSEQUENTIALID Results](./sql-sequential-guids.png)\\r\\n\\r\\n(in case anyone is curious, generating the GUIDs randomly led to a fragmentation percentage of almost 99%)\\r\\n\\r\\n### Studying the Issue\\r\\n\\r\\nThere were two main benefits that initially brought us to use GUIDs as primary keys in our database.\\r\\n1. We sometimes have to export data across servers, so the (near) uniqueness guarantee meant that it should be trivial to merge the data\\r\\n2. Certain actions don\'t require our users to be connected to our server all the time as long as they do a periodic sync. In this case we could let the client generate IDs and after the sync turn the IDs into sequential ones. Once we were done with the transformation we just had to inform the client of the new IDs.\\r\\n\\r\\nUnfortunately, the SQL server GUIDs don\'t seem like they would be able to cut it for us, as it seems likely that a collision could occur when exporting from one server to another.\\r\\n\\r\\nThis led us to a tough crossroad. Do we\\r\\n1. Keep going, knowing that scaling up our application leads to highly diminishing returns necessitating expensive hardware OR\\r\\n2. Lose the benefits GUIDs give us in favor of another primary key format that would be better suited for parallel inserts.\\r\\n\\r\\nUltimately, we decided that our best path forward was to go with a hybrid approach. We would alter our tables to have two IDs where GUIDs are required. This involved using an integer primary key generated by the database, and GUID value as a non-clustered index with a unique constraint. These GUIDs would use the `SequentialGuidValueGenerator` to try to \\"presort\\" some of the items in the non-clustered index, but we wouldn\'t enforce that it had to be a sequential GUID.\\r\\n\\r\\nAfter performing our parallel benchmark, we ended up with the following results:\\r\\n###### Hybrid Key Generation Approach\\r\\n| average page space used in % | average fragmentation in percent | Record Count\\r\\n| ---: | ---: | ---: |\\r\\n| 94.15 % | 10.38 % | 100000 |\\r\\n\\r\\nJust in case we ran the benchmark again with only an integer primary key, that yielded a fragmentation percentage of almost exactly 12%. It really just seems that some fragmentation is unavoidable in a parallel context.\\r\\n\\r\\n\\r\\n### The Great Key Migration\\r\\n\\r\\nArmed with the results of the benchmarks we had ran, we decided that we would make a gamble. Every table that we had that used a GUID primary key we would alter to contain an auto-incrementing integer primary key, and a GUID UniqueId column with a unique constraint enforced. We would still use the Entity Framework Core GUID value generator to create these unique Ids so to reduce the amount of work SQL would have to do maintaining the unique constraint.\\r\\n\\r\\nIn the end, it took roughly two weeks of work, and by the end we had modified 600 files according to Git. We ran the benchmark again with the new composite keys and our test script outputted the result:\\r\\n\\r\\n```\\r\\n612304 total requests completed\\r\\n153076 form submissions in 10 minutes across 20 tasks\\r\\n```\\r\\n\\r\\nThis absolutely shocked us. We had more than doubled our throughput, obtaining a total boost of **~127%** by changing our code to use integer primary keys instead of GUIDs. Some may say the time investment or the risk involved isn\'t worth it, but in our minds, the tradeoff we got was more than worth it.\\r\\n\\r\\n### Closing\\r\\n\\r\\nI\'d like to end this post with a couple of acknowledgements.\\r\\n\\r\\nFirst, I don\'t believe that using the sequential id generator strategy is bad. The Entity Framework Core team\'s benchmarks show that it does great work in a purely sequential workload. As long as you aren\'t expecting a high degree of parallelism, it seems that they are perfectly fine as a primary key. Even if you do have a parallel workload, its still possible to reorganize your clustered indexes.\\r\\n\\r\\nSecond, I want to acknowledge that its totally possible that this is all a coincidence, and that the GUIDs weren\'t the cause of the performance issues that we were seeing in SQL Server. It\'s our belief that it\'s the culprit. It\'s also of secondary importance for us to raise awareness that the assumption that we made, that because `SequentialGUidValueGenerator` uses a strategy optimized for sequential access in SQL server, that GUIDs aren\'t always going to be *inserted* sequentially.\\r\\n\\r\\nLastly, I encourage anyone who reads this to look into the methods enclosed and run their own benchmarks to draw their own conclusions. If there is a flaw in my methods I\'m happy to make an edit or publish a correction.\\r\\n\\r\\n### Thank You!\\r\\nThank you for reading my first blog post, please let me know what worked, and what didn\'t\\r\\n\\r\\n-- Conner\\r\\n\\r\\n<a name=\\"footnote1\\"> 1</a> It still perplexes us as to how it didn\'t show up on the smaller machine. It\'s possible (spoiler) that since we had less cores we had a lesser degree of parallelism, so rows were not being inserted out of order as bad."},{"id":"welcome","metadata":{"permalink":"/website/blog/welcome","editUrl":"https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/blog/2021-08-26-welcome/index.md","source":"@site/blog/2021-08-26-welcome/index.md","title":"Welcome","description":"Docusaurus blogging features are powered by the blog plugin.","date":"2021-08-26T00:00:00.000Z","formattedDate":"August 26, 2021","tags":[{"label":"facebook","permalink":"/website/blog/tags/facebook"},{"label":"hello","permalink":"/website/blog/tags/hello"},{"label":"docusaurus","permalink":"/website/blog/tags/docusaurus"}],"readingTime":0.405,"hasTruncateMarker":false,"authors":[{"name":"S\xe9bastien Lorber","title":"Docusaurus maintainer","url":"https://sebastienlorber.com","imageURL":"https://github.com/slorber.png","key":"slorber"},{"name":"Yangshun Tay","title":"Front End Engineer @ Facebook","url":"https://github.com/yangshun","imageURL":"https://github.com/yangshun.png","key":"yangshun"}],"frontMatter":{"slug":"welcome","title":"Welcome","authors":["slorber","yangshun"],"tags":["facebook","hello","docusaurus"]},"prevItem":{"title":"Sequential GUIDs in EF Core Might Not Be Sequential","permalink":"/website/blog/Sequential GUIDs in EF Core Might Not Be Sequential"},"nextItem":{"title":"MDX Blog Post","permalink":"/website/blog/mdx-blog-post"}},"content":"[Docusaurus blogging features](https://docusaurus.io/docs/blog) are powered by the [blog plugin](https://docusaurus.io/docs/api/plugins/@docusaurus/plugin-content-blog).\\n\\nSimply add Markdown files (or folders) to the `blog` directory.\\n\\nRegular blog authors can be added to `authors.yml`.\\n\\nThe blog post date can be extracted from filenames, such as:\\n\\n- `2019-05-30-welcome.md`\\n- `2019-05-30-welcome/index.md`\\n\\nA blog post folder can be convenient to co-locate blog post images:\\n\\n![Docusaurus Plushie](./docusaurus-plushie-banner.jpeg)\\n\\nThe blog supports tags as well!\\n\\n**And if you don\'t want a blog**: just delete this directory, and use `blog: false` in your Docusaurus config."},{"id":"mdx-blog-post","metadata":{"permalink":"/website/blog/mdx-blog-post","editUrl":"https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/blog/2021-08-01-mdx-blog-post.mdx","source":"@site/blog/2021-08-01-mdx-blog-post.mdx","title":"MDX Blog Post","description":"Blog posts support Docusaurus Markdown features, such as MDX.","date":"2021-08-01T00:00:00.000Z","formattedDate":"August 1, 2021","tags":[{"label":"docusaurus","permalink":"/website/blog/tags/docusaurus"}],"readingTime":0.175,"hasTruncateMarker":false,"authors":[{"name":"S\xe9bastien Lorber","title":"Docusaurus maintainer","url":"https://sebastienlorber.com","imageURL":"https://github.com/slorber.png","key":"slorber"}],"frontMatter":{"slug":"mdx-blog-post","title":"MDX Blog Post","authors":["slorber"],"tags":["docusaurus"]},"prevItem":{"title":"Welcome","permalink":"/website/blog/welcome"},"nextItem":{"title":"Long Blog Post","permalink":"/website/blog/long-blog-post"}},"content":"Blog posts support [Docusaurus Markdown features](https://docusaurus.io/docs/markdown-features), such as [MDX](https://mdxjs.com/).\\n\\n:::tip\\n\\nUse the power of React to create interactive blog posts.\\n\\n```js\\n<button onClick={() => alert(\'button clicked!\')}>Click me!</button>\\n```\\n\\n<button onClick={() => alert(\'button clicked!\')}>Click me!</button>\\n\\n:::"},{"id":"long-blog-post","metadata":{"permalink":"/website/blog/long-blog-post","editUrl":"https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/blog/2019-05-29-long-blog-post.md","source":"@site/blog/2019-05-29-long-blog-post.md","title":"Long Blog Post","description":"This is the summary of a very long blog post,","date":"2019-05-29T00:00:00.000Z","formattedDate":"May 29, 2019","tags":[{"label":"hello","permalink":"/website/blog/tags/hello"},{"label":"docusaurus","permalink":"/website/blog/tags/docusaurus"}],"readingTime":2.05,"hasTruncateMarker":true,"authors":[{"name":"Endilie Yacop Sucipto","title":"Maintainer of Docusaurus","url":"https://github.com/endiliey","imageURL":"https://github.com/endiliey.png","key":"endi"}],"frontMatter":{"slug":"long-blog-post","title":"Long Blog Post","authors":"endi","tags":["hello","docusaurus"]},"prevItem":{"title":"MDX Blog Post","permalink":"/website/blog/mdx-blog-post"},"nextItem":{"title":"First Blog Post","permalink":"/website/blog/first-blog-post"}},"content":"This is the summary of a very long blog post,\\n\\nUse a `\x3c!--` `truncate` `--\x3e` comment to limit blog post size in the list view.\\n\\n\x3c!--truncate--\x3e\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet\\n\\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet"},{"id":"first-blog-post","metadata":{"permalink":"/website/blog/first-blog-post","editUrl":"https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/blog/2019-05-28-first-blog-post.md","source":"@site/blog/2019-05-28-first-blog-post.md","title":"First Blog Post","description":"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet","date":"2019-05-28T00:00:00.000Z","formattedDate":"May 28, 2019","tags":[{"label":"hola","permalink":"/website/blog/tags/hola"},{"label":"docusaurus","permalink":"/website/blog/tags/docusaurus"}],"readingTime":0.12,"hasTruncateMarker":false,"authors":[{"name":"Gao Wei","title":"Docusaurus Core Team","url":"https://github.com/wgao19","image_url":"https://github.com/wgao19.png","imageURL":"https://github.com/wgao19.png"}],"frontMatter":{"slug":"first-blog-post","title":"First Blog Post","authors":{"name":"Gao Wei","title":"Docusaurus Core Team","url":"https://github.com/wgao19","image_url":"https://github.com/wgao19.png","imageURL":"https://github.com/wgao19.png"},"tags":["hola","docusaurus"]},"prevItem":{"title":"Long Blog Post","permalink":"/website/blog/long-blog-post"}},"content":"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque elementum dignissim ultricies. Fusce rhoncus ipsum tempor eros aliquam consequat. Lorem ipsum dolor sit amet"}]}')}}]);